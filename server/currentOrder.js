import express from "express";
import pool from "./db.js";
import crypto from "crypto";
import { getCustomerDiscount } from "./customers.js";

/** --- helpers --- */
export async function resolveCompanyContext(req, res) {
    const u = req.user || {};
    let companyId = u.companyId ?? u.company_id ?? null;

    if (!companyId) {
        const userId = u.userId ?? u.id ?? null;
        if (!userId) {
            res.status(400).json({ ok: false, error: "Не удалось определить пользователя" });
            return null;
        }
        const [rows] = await pool.query(
            "SELECT company_id FROM users WHERE user_id=? LIMIT 1",
            [userId]
        );
        if (!rows.length) {
            res.status(404).json({ ok: false, error: "Пользователь не найден" });
            return null;
        }
        companyId = rows[0].company_id;
        req.user = { ...u, companyId };
    }
    return { companyId: Number(companyId), user: req.user };
}

// формат времени для MySQL DATETIME: "2026-04-28 11:50:00"
function toMySQLDatetime(isoString) {
    if (!isoString) return null;
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return null;
    // "2026-04-28T11:50:00.000Z" → "2026-04-28 11:50:00"
    return d.toISOString().slice(0, 19).replace("T", " ");
}

// orderDiscount (необяз.): { type: 'percent'|'fixed', value } — постоянная
// скидка клиента, привязанная к телефону.
// manualPercent (необяз.): разовая скидка на этот заказ, 0..100.
//
// Обе скидки процентные, поэтому применяется БОЛЬШАЯ из них, а не сумма:
// карта −10% и разовая −20% должны дать −20%, а не −30%.
function normalizeItemsAndAmounts(items, deliveryFee, orderDiscount = null, manualPercent = 0) {
    const toCents = (amount) => {
        const s = typeof amount === "string" ? amount.trim().replace(",", ".") : amount;
        const n = Number(s);
        if (!Number.isFinite(n) || n < 0) return 0;
        return Math.round((n + Number.EPSILON) * 100);
    };

    const formatCents = (cents) => (Math.round(Number(cents) || 0) / 100).toFixed(2);

    const discountedUnitCents = (price, discountPercent = 0) => {
        const priceCents = toCents(price);
        const d = Number(discountPercent) || 0;
        if (d <= 0) return priceCents;
        if (d >= 100) return 0;
        return Math.round((priceCents * (100 - d)) / 100);
    };

    const norm = (Array.isArray(items) ? items : []).map((it) => {
        const price = Number(it.price || 0);
        const discount = Number(it.discount || 0);
        const qty = Number(it.quantity || 0);

        const priceCents = toCents(price);
        const unitCents = discountedUnitCents(price, discount);
        const lineCents = unitCents * qty;

        return {
            id: it.id ?? null,
            name: it.name ?? "",
            price,
            discount,
            final_price: Number(formatCents(unitCents)),
            quantity: qty,
            line_total: Number(formatCents(lineCents)),
            _price_cents: priceCents,
            _line_cents: lineCents,
        };
    });

    const subtotalCents = norm.reduce((s, r) => s + r._price_cents * r.quantity, 0);
    const itemsTotalCents = norm.reduce((s, r) => s + r._line_cents, 0);

    // База для ПРОЦЕНТНОЙ скидки клиента — только позиции без скидки в меню.
    // Раньше процент брался со всей суммы, и на акционном товаре скидка
    // складывалась дважды: −20% в меню и сверху −10% персональных.
    const percentBaseCents = norm.reduce(
        (s, r) => (Number(r.discount) > 0 ? s : s + r._price_cents * r.quantity),
        0
    );

    // Постоянная скидка клиента поверх поштучных скидок.
    // Та же формула на клиенте — utils/money.js, customerDiscountCents.
    let personalCents = 0;
    if (orderDiscount && Number(orderDiscount.value) > 0) {
        const v = Number(orderDiscount.value) || 0;
        if (orderDiscount.type === "fixed") {
            // Фиксированная сумма вычитается из всего заказа: удвоения скидки
            // тут не возникает, поведение оставлено прежним.
            personalCents = Math.min(toCents(v), itemsTotalCents);
        } else {
            const pct = Math.min(v, 100);
            personalCents = Math.round((percentBaseCents * pct) / 100);
        }
    }

    // Разовая скидка на заказ
    const manual = Number(manualPercent);
    const manualCents =
        Number.isFinite(manual) && manual > 0
            ? Math.round((percentBaseCents * Math.min(manual, 100)) / 100)
            : 0;

    // Не складываем: клиент получает лучшее из двух условий
    const orderDiscountCents = Math.max(personalCents, manualCents);
    const itemsAfterOrderDiscCents = Math.max(0, itemsTotalCents - orderDiscountCents);

    // amount_discount = поштучные скидки + персональная скидка клиента
    const discountCents = subtotalCents - itemsAfterOrderDiscCents;
    const deliveryFeeCents = toCents(deliveryFee);
    const totalCents = itemsAfterOrderDiscCents + deliveryFeeCents;

    // не сохраняем служебные поля в items_json
    const itemsClean = norm.map(({ _price_cents, _line_cents, ...rest }) => rest);

    return {
        items: itemsClean,
        amount_subtotal: formatCents(subtotalCents),
        amount_discount: formatCents(discountCents),
        amount_total: formatCents(totalCents),
        delivery_fee: formatCents(deliveryFeeCents),
        order_discount_cents: orderDiscountCents,
    };
}

export function rowToPanelDto(r) {
    const addr = [
        r.address_street,
        r.address_house && `д.${r.address_house}`,
        r.address_building && `к.${r.address_building}`,
        r.address_apartment && `кв.${r.address_apartment}`,
        r.address_floor && `эт.${r.address_floor}`,
        r.address_code && `код ${r.address_code}`,
    ].filter(Boolean).join(", ");

    return {
        id: r.order_id,
        orderNo: r.order_no,
        orderSeq: r.order_seq ?? null,
        orderDay: r.order_seq_date ?? null,
        orderType: r.order_type,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        completedAt: r.completed_at ?? null,
        scheduledAt: r.scheduled_at,
        amountTotal: Number(r.amount_total),
        deliveryFee: Number(r.delivery_fee || 0),
        numOfPeople: Number(r.people_amount || 0),
        paymentMethod: r.payment_method,
        // Разовая скидка на заказ: без неё форма редактирования не смогла бы
        // показать выбранный процент и потеряла бы его при сохранении.
        manualDiscountPercent: Number(r.manual_discount_percent || 0),
        customer: r.customer_name,
        phone: r.customer_phone,
        address: addr,
        pickupName: r.pickup_nickname || "",
        courierName: r.courier_nickname || "",
        dispatcherUnitId: r.dispatcher_unit_id,
        pickupId: r.pickup_unit_id,
        courierId: r.courier_unit_id,

        // координаты (для карты/деталей)
        addressLat: r.address_lat != null ? Number(r.address_lat) : null,
        addressLng: r.address_lng != null ? Number(r.address_lng) : null,
        geocodedAt: r.geocoded_at ?? null,
        geocodeProvider: r.geocode_provider ?? null,
    };
}

/** Разовая скидка на заказ: целое 0..100, всё остальное — 0 */
function coerceManualDiscount(value) {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(n, 100);
}

function safeParseItemsJSON(v) {
    try {
        if (v == null) return [];
        if (typeof v === "string") return JSON.parse(v);
        if (Buffer.isBuffer(v)) return JSON.parse(v.toString("utf8"));
        if (typeof v === "object") return v;
        return [];
    } catch {
        return [];
    }
}

export const PAYMENT_METHODS = ["cash", "card", "wire", "paid"];

/** Статусы заказа. Совпадают со списком в EditOrder и в панели заказов. */
export const ORDER_STATUSES = [
    "new", "preparing", "ready", "enroute", "completed", "cancelled",
];

/**
 * За сколько часов до времени доставки предзаказ становится «рабочим»:
 * джоба activatePreorders переводит его в активные, и он появляется у курьеров.
 *
 * Константа одна на весь сервер намеренно. Раньше двойка была вписана прямо в
 * SQL джобы; стоит появиться второй копии в другом месте — и заказ повиснет
 * между «курьеру уже видно» и «ещё не активирован», либо наоборот.
 */
export const PREORDER_LEAD_HOURS = 2;

/**
 * Условие «этот заказ уже можно показывать курьеру».
 *
 * Отбираем по ВРЕМЕНИ, а не по order_type. Джоба активации ищет заказы с
 * `scheduled_at > NOW()`, поэтому предзаказ, время которого уже прошло (создан
 * задним числом либо сервер простоял дольше окна), не активируется никогда.
 * Проверка по типу спрятала бы такой заказ от курьера навсегда; проверка по
 * времени показывает его сразу.
 *
 * Завершённые заказы условию не подчиняются: вкладка «Мои» показывает
 * закрытые за сегодня, и они не должны пропадать из истории курьера.
 */
export function courierVisibleOrderSql(alias = "co") {
    return `(
        ${alias}.status = 'completed'
        OR ${alias}.order_type <> 'preorder'
        OR ${alias}.scheduled_at IS NULL
        OR ${alias}.scheduled_at <= DATE_ADD(NOW(), INTERVAL ${PREORDER_LEAD_HOURS} HOUR)
    )`;
}

/**
 * Заказ ещё не пора нести курьеру — нужно при рассылке WS и push, где SQL
 * уже не при чём.
 *
 * Проверяем ТИП, а не время, и это осознанно. Сравнение времени в Node
 * зависело бы от часового пояса процесса и настроек mysql2, а `order_type`
 * переключает та же джоба, что и определяет момент активации, — то есть
 * источник истины один, и разъехаться он не может.
 *
 * Заказ, созданный на время в пределах окна, останется 'preorder' максимум до
 * следующего тика джобы (минута). В эту минуту курьер увидит его в списке
 * (SQL-фильтр работает по времени), а push придёт сразу после активации.
 */
export function isPreorderNotYetActive(order) {
    if (!order) return false;
    return (order.orderType ?? order.order_type ?? null) === "preorder";
}

/**
 * Приводит способ оплаты к каноническому коду.
 *
 * Возвращает null, если значение не распознано. Раньше здесь стоял молчаливый
 * возврат "cash" — из-за него любой неизвестный метод превращался в наличные,
 * и заказ попадал в кассу курьера, хотя денег он не получал. Такую ошибку
 * никто не замечает, пока не сойдётся отчёт, поэтому теперь неизвестное
 * значение обрабатывают вызывающие: POST отвечает ошибкой, PUT сохраняет
 * прежний метод.
 */
function coercePaymentMethod(val) {
    const s = String(val || "").trim().toLowerCase();
    if (["cash", "наличные", "нал"].includes(s)) return "cash";
    if (["card", "карта", "банковская карта"].includes(s)) return "card";
    if (["wire", "перечислением", "безнал", "безналичный"].includes(s)) return "wire";
    // «Оплачен» — заказ уже оплачен до доставки, курьер денег не берёт
    if (["paid", "оплачен", "оплачено", "apmaksats", "apmaksāts"].includes(s)) return "paid";
    return null;
}

/** Определяем «операционный день» для нумерации */
export function deriveOrderSeqDate(orderType, scheduledAt) {
    if (orderType === "preorder" && scheduledAt) {
        const d = new Date(scheduledAt);
        return d.toISOString().slice(0, 10);
    }
    const now = new Date();
    return now.toISOString().slice(0, 10);
}

/** Ленивая авто-миграция колонки completed_at (выполняется один раз) */
let _completedAtReady = false;
export async function ensureCompletedAtColumn() {
    if (_completedAtReady) return;
    try {
        const [rows] = await pool.query(
            `SELECT COUNT(*) AS c
               FROM information_schema.columns
              WHERE table_schema = DATABASE()
                AND table_name = 'current_orders'
                AND column_name = 'completed_at'`
        );
        if (!rows.length || Number(rows[0].c) === 0) {
            await pool.query(`ALTER TABLE current_orders ADD COLUMN completed_at DATETIME NULL`);
        }
        _completedAtReady = true;
    } catch (e) {
        console.warn("ensureCompletedAtColumn failed:", e?.message || e);
    }
}

/** Границы текущего операционного дня в UTC (та же конвенция, что у order_seq_date) */
export function todayUtcRange() {
    const now = new Date();
    const startDate = now.toISOString().slice(0, 10);
    const nextDate = new Date(now.getTime() + 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
    return { start: `${startDate} 00:00:00`, end: `${nextDate} 00:00:00` };
}

/**
 * Проверяет дату операционного дня для архива.
 *
 * Возвращает "YYYY-MM-DD" либо null, если строка не подходит: неверный формат,
 * несуществующий день (например 2026-02-31) или дата из будущего. Значение
 * уходит в запрос параметром, но формат всё равно проверяем — так ошибка
 * видна сразу, а не превращается в пустой список.
 */
export function normalizeSeqDate(value) {
    const s = String(value ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;

    // Отсекаем несуществующие даты: Date их «исправляет» (31.02 → 03.03),
    // поэтому сверяем результат с исходной строкой.
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    if (d.toISOString().slice(0, 10) !== s) return null;

    // Будущий операционный день смотреть незачем: заказов там нет,
    // а запрос выглядел бы как рабочий.
    const today = todayUtcRange().start.slice(0, 10);
    if (s > today) return null;

    return s;
}

/** Транзакционное получение следующего порядкового номера за день */
export async function allocateDailySeq(conn, companyId, orderSeqDate) {
    const [rows] = await conn.query(
        `SELECT COALESCE(MAX(order_seq), 0) AS max_seq
       FROM current_orders
      WHERE company_id=? AND order_seq_date=?
      FOR UPDATE`,
        [companyId, orderSeqDate]
    );
    const next = Number(rows[0]?.max_seq || 0) + 1;
    return next;
}

/** -------------------- GEOAPIFY -------------------- */
function buildGeoTextFromBody(b) {
    const street = String(b.street || "").trim();
    const house = String(b.house || "").trim();
    const building = String(b.building || "").trim();
    const apart = String(b.apart || "").trim();

    if (!street) return null;

    // Формат: Ozolciema iela 42 k-1
    const main =
        house
            ? `${street} ${house}${building ? ` k-${building}` : ""}`
            : street;

    const aptPart = apart ? ` dz. ${apart}` : "";

    const text = `${main}${aptPart}, Riga, Latvia`.trim();

    return text.length > 5 ? text : null;
}

async function geoapifyGeocodeText(text) {
    const apiKey = process.env.GEOAPIFY_KEY;
    if (!apiKey) return { ok: false, error: "GEOAPIFY_KEY missing" };

    const url =
        "https://api.geoapify.com/v1/geocode/search" +
        `?text=${encodeURIComponent(text)}` +
        `&format=json&limit=1&apiKey=${encodeURIComponent(apiKey)}`;

    // Node 18+ имеет глобальный fetch.
    const res = await fetch(url, {
        headers: { "User-Agent": "delivery-admin/1.0 (support@yourdomain.com)" },
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: `Geoapify ${res.status}: ${body.slice(0, 200)}` };
    }

    const data = await res.json();
    const item = data?.results?.[0];
    if (!item) return { ok: false, error: "No geocode results" };

    const lat = Number(item.lat);
    const lng = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, error: "Invalid coordinates" };

    return { ok: true, lat, lng, raw: item };
}

/** map dto */
function rowToMapDto(r) {
    const addr = [
        r.address_street,
        r.address_house ? `д.${r.address_house}` : null,
        r.address_building ? `к.${r.address_building}` : null,
        r.address_apartment ? `кв.${r.address_apartment}` : null,
        r.address_floor ? `эт.${r.address_floor}` : null,
        r.address_code ? `код ${r.address_code}` : null,
    ].filter(Boolean).join(", ");

    return {
        orderId: r.order_id,
        status: r.status,
        orderType: r.order_type,
        customer: r.customer_name,
        phone: r.customer_phone,
        courierId: r.courier_unit_id ?? null,
        courierName: r.courier_name ?? null,
        pickupId: r.pickup_unit_id ?? null,
        address: addr,

        addressStreet: r.address_street ?? null,
        addressHouse: r.address_house ?? null,
        addressBuilding: r.address_building ?? null,
        addressApartment: r.address_apartment ?? null,
        addressFloor: r.address_floor ?? null,
        addressCode: r.address_code ?? null,

        addressLat: r.address_lat != null ? Number(r.address_lat) : null,
        addressLng: r.address_lng != null ? Number(r.address_lng) : null,

    };
}

/** --- router factory (инжектим broadcastToAdmins из index.js) --- */
export function currentOrdersRouter({ broadcastToAdmins }) {
    const router = express.Router();

    // GET /api/current-orders/map  (для карты: только активные + с координатами)
    router.get("/map", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;

            const [rows] = await pool.query(
                `SELECT co.order_id, co.status, co.order_type, co.customer_name, co.customer_phone,
                co.courier_unit_id, co.pickup_unit_id,
                co.address_street, co.address_house,
                co.address_building, co.address_apartment,
                co.address_floor, co.address_code,
                co.address_lat, co.address_lng,
                cu.nickname AS courier_name
         FROM current_orders co
         LEFT JOIN users cu ON cu.user_id = co.courier_unit_id
         WHERE co.company_id=?
           AND co.status IN ('new','ready','enroute')
           AND co.address_lat IS NOT NULL AND co.address_lng IS NOT NULL
         ORDER BY co.created_at DESC
         LIMIT 500`,
                [companyId]
            );

            res.json({ ok: true, items: rows.map(rowToMapDto) });
        } catch (e) {
            console.error("map current orders", e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    // GET /api/current-orders?tab=active|preorders|completed|history
    //   history дополнительно требует date=YYYY-MM-DD
    router.get("/", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;
            const tab = (req.query.tab || "active").toLowerCase();

            await ensureCompletedAtColumn();

            const where = ["co.company_id=?"];
            const params = [companyId];
            // История отдаётся по номеру заказа за день, остальные вкладки —
            // по времени создания, как было
            let orderBy = "co.created_at DESC, co.order_id DESC";

            if (tab === "active") {
                where.push("co.order_type='active'");
                where.push("co.status IN ('new','preparing','ready','enroute')");
            } else if (tab === "preorders") {
                where.push("co.order_type='preorder'");
                where.push("co.status NOT IN ('completed','cancelled')");
            } else if (tab === "completed") {
                // только заказы, завершённые СЕГОДНЯ (UTC-день, как order_seq_date)
                const { start, end } = todayUtcRange();
                where.push("co.status='completed'");
                where.push("co.completed_at >= ? AND co.completed_at < ?");
                params.push(start, end);
            } else if (tab === "history") {
                // Архив за один операционный день. Отбор по order_seq_date:
                // это тот же день, по которому заказы нумеруются, он всегда
                // заполнен (в отличие от completed_at у старых и отменённых)
                // и не сдвигается при редактировании заказа.
                const date = normalizeSeqDate(req.query.date);
                if (!date) {
                    return res.status(400).json({
                        ok: false,
                        error: "Некорректная дата: ожидается YYYY-MM-DD, не позже сегодняшнего дня",
                    });
                }
                // Статусы не фильтруем: за прошедший день нужно видеть и
                // незакрытые заказы, чтобы их можно было завершить вручную.
                where.push("co.order_seq_date = ?");
                params.push(date);
                orderBy = "co.order_seq DESC, co.order_id DESC";
            }

            const sql = `
        SELECT co.*,
               cu1.nickname AS courier_nickname,
               cu2.nickname AS pickup_nickname
        FROM current_orders co
                 LEFT JOIN users cu1 ON cu1.user_id = co.courier_unit_id
                 LEFT JOIN users cu2 ON cu2.user_id = co.pickup_unit_id
        WHERE ${where.join(" AND ")}
        ORDER BY ${orderBy}
        LIMIT 500`;
            const [rows] = await pool.query(sql, params);

            res.json({ ok: true, items: rows.map(rowToPanelDto) });
        } catch (e) {
            console.error("list current orders", e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    // GET /api/current-orders/:id
    router.get("/:id", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;
            const id = Number(req.params.id);

            const sql = `
        SELECT co.*,
               cu1.nickname AS courier_nickname,
               cu2.nickname AS pickup_nickname
        FROM current_orders co
                 LEFT JOIN users cu1 ON cu1.user_id = co.courier_unit_id
                 LEFT JOIN users cu2 ON cu2.user_id = co.pickup_unit_id
        WHERE co.company_id=? AND co.order_id=? LIMIT 1`;
            const [rows] = await pool.query(sql, [companyId, id]);
            if (!rows.length) return res.status(404).json({ ok: false, error: "Заказ не найден" });

            const r = rows[0];
            const dto = rowToPanelDto(r);
            dto.items = safeParseItemsJSON(r.items_json);
            dto.notes = r.notes;

            // раздельные поля адреса (для формы)
            dto.addressStreet = r.address_street;
            dto.addressHouse = r.address_house;
            dto.addressBuilding = r.address_building;
            dto.addressApartment = r.address_apartment;
            dto.addressFloor = r.address_floor;
            dto.addressCode = r.address_code;

            res.json({ ok: true, item: dto });
        } catch (e) {
            console.error("get current order", e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    // POST /api/current-orders
    router.post("/", async (req, res) => {
        let conn;
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId, user } = ctx;
            const b = req.body || {};

            if (!b.customer || !b.phone)
                return res.status(400).json({ ok: false, error: "Имя и телефон обязательны" });

            // Персональная скидка клиента (по телефону, в рамках компании).
            // Всегда применяется автоматически при создании заказа.
            // Клиент может отключить её для конкретного заказа (applyCustomerDiscount=false).
            let orderDiscount = null;
            if (b.applyCustomerDiscount !== false) {
                try {
                    orderDiscount = await getCustomerDiscount(companyId, b.phone);
                } catch (e) {
                    console.warn("getCustomerDiscount failed:", e?.message ?? e);
                }
            }

            const manualDiscountPercent = coerceManualDiscount(b.manualDiscountPercent);
            const { items, amount_subtotal, amount_discount, amount_total, delivery_fee } =
                normalizeItemsAndAmounts(
                    b.selectedItems || [], b.deliveryFee, orderDiscount, manualDiscountPercent
                );
            if (!b.payment)
                return res.status(400).json({ ok: false, error: "Способ оплаты обязателен" });

            const orderNo = b.orderNo || `CO-${Date.now().toString().slice(-8)}`;
            const payment_method = coercePaymentMethod(b.payment);
            if (!payment_method) {
                // Лучше отказать, чем тихо записать наличные и испортить отчёт
                console.warn(`[order] неизвестный способ оплаты: ${JSON.stringify(b.payment)}`);
                return res.status(400).json({
                    ok: false,
                    error: `Неизвестный способ оплаты: ${b.payment}. Допустимо: ${PAYMENT_METHODS.join(", ")}`,
                });
            }
            const order_type = b.orderType || "active";
            const scheduled_at = toMySQLDatetime(b.scheduledAt);

            // определяем «операционный день»
            const order_seq_date = deriveOrderSeqDate(order_type, scheduled_at);

            conn = await pool.getConnection();
            let attempts = 0;
            let result;

            while (true) {
                attempts++;
                try {
                    await conn.beginTransaction();

                    // берём следующий порядковый номер за день под блокировкой
                    const nextSeq = await allocateDailySeq(conn, companyId, order_seq_date);

                    const [ins] = await conn.query(
                        `INSERT INTO current_orders
             (company_id, order_no, order_seq, order_seq_date,
              order_type, status, scheduled_at,
              courier_unit_id, pickup_unit_id, dispatcher_unit_id,
              payment_method,
              delivery_fee,
              customer_name, customer_phone,
              address_street, address_house, address_building, address_apartment, address_floor, address_code,
              people_amount, notes,
              manual_discount_percent,
              items_json, amount_subtotal, amount_discount, amount_total)
             VALUES
             (?, ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?,
              ?,
              ?,
              ?, ?,
              ?, ?, ?, ?, ?, ?,
              ?,?,
              ?,
              ?, ?, ?, ?)`,
                        [
                            companyId, orderNo, nextSeq, order_seq_date,
                            order_type, b.status || "new", scheduled_at,
                            b.courierId || null, b.pickupId || null, (user && user.unitId) || null,
                            payment_method,
                            delivery_fee,
                            b.customer, b.phone,
                            b.street || null, b.house || null, b.building || null, b.apart || null, b.floor || null, b.code || null,
                            b.numOfPeople || null, b.notes || null,
                            manualDiscountPercent,
                            JSON.stringify(items), amount_subtotal, amount_discount, amount_total
                        ]
                    );

                    await conn.commit();
                    result = ins;
                    break; // успех
                } catch (e) {
                    await conn.rollback();
                    if (e && e.code === "ER_DUP_ENTRY" && attempts < 5) {
                        await new Promise((r) => setTimeout(r, 10 + Math.random() * 40));
                        continue;
                    }
                    throw e;
                }
            }

            const order_id = result.insertId;

            // Координаты доставки.
            // Если админ проверил и подтвердил адрес на карте при создании —
            // используем переданные координаты (точнее, проверено человеком).
            // Иначе — fallback на серверный геокодинг (как раньше).
            const manualLat = Number(b.addressLat);
            const manualLng = Number(b.addressLng);
            const hasManualCoords =
                Number.isFinite(manualLat) && Number.isFinite(manualLng);

            if (hasManualCoords) {
                try {
                    await pool.query(
                        `UPDATE current_orders
                           SET address_lat=?, address_lng=?, geocoded_at=NOW(),
                               geocode_provider='manual', updated_at=NOW()
                         WHERE company_id=? AND order_id=?`,
                        [manualLat, manualLng, companyId, order_id]
                    );
                } catch (ge) {
                    console.warn("manual coords save failed:", ge?.message || ge);
                }
            } else {
                // Геокодинг сразу после создания (best-effort)
                const geoText = buildGeoTextFromBody(b);
                if (geoText) {
                    try {
                        const geo = await geoapifyGeocodeText(geoText);
                        if (geo.ok) {
                            await pool.query(
                                `UPDATE current_orders
                   SET address_lat=?, address_lng=?, geocoded_at=NOW(),
                       geocode_provider='geoapify', geocode_raw=?, updated_at=NOW()
                   WHERE company_id=? AND order_id=?`,
                                [geo.lat, geo.lng, JSON.stringify(geo.raw), companyId, order_id]
                            );
                        }
                    } catch (ge) {
                        // Не валим создание заказа, просто логируем
                        console.warn("geoapify geocode failed:", ge?.message || ge);
                    }
                }
            }

            // читаем уже обновлённый заказ (с координатами)
            const [rows] = await pool.query(
                `SELECT co.*,
                cu1.nickname AS courier_nickname,
                cu2.nickname AS pickup_nickname
         FROM current_orders co
                  LEFT JOIN users cu1 ON cu1.user_id = co.courier_unit_id
                  LEFT JOIN users cu2 ON cu2.user_id = co.pickup_unit_id
         WHERE co.company_id=? AND co.order_id=? LIMIT 1`,
                [companyId, order_id]
            );

            const item = rowToPanelDto(rows[0]);
            res.json({ ok: true, item });

            if (typeof broadcastToAdmins === "function") {
                broadcastToAdmins({
                    type: "order_created",
                    eventId: crypto.randomUUID(),
                    ts: Date.now(),
                    companyId,
                    order: item, // ✅ уже с addressLat/addressLng
                });
            }
        } catch (e) {
            // Общее «Ошибка сервера» ничего не объясняет: возвращаем сообщение
            // MySQL, иначе причину видно только в логах контейнера.
            const detail = e?.sqlMessage || e?.message || String(e);
            console.error("create current order:", e?.code || "", detail);
            res.status(500).json({ ok: false, error: `Ошибка сервера: ${detail}` });
        } finally {
            if (conn) conn.release();
        }
    });

    // PUT /api/current-orders/:id
    router.put("/:id", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;
            const id = Number(req.params.id);
            const b = req.body || {};

            // Сохраняем персональную скидку клиента и при редактировании заказа
            let orderDiscount = null;
            if (b.applyCustomerDiscount !== false && b.phone) {
                try {
                    orderDiscount = await getCustomerDiscount(companyId, b.phone);
                } catch (e) {
                    console.warn("getCustomerDiscount (edit) failed:", e?.message ?? e);
                }
            }

            const manualDiscountPercent = coerceManualDiscount(b.manualDiscountPercent);
            const { items, amount_subtotal, amount_discount, amount_total, delivery_fee } =
                normalizeItemsAndAmounts(
                    b.selectedItems || [], b.deliveryFee, orderDiscount, manualDiscountPercent
                );

            // Кто вёз заказ до правки: нужно, чтобы отличить «назначили курьера»
            // от обычного редактирования и уведомить нового исполнителя.
            // Заодно забираем прежний способ оплаты — он станет запасным
            // вариантом, если клиент прислал значение, которое мы не знаем.
            let prevCourierId = null;
            let prevPayment = null;
            try {
                const [[prev]] = await pool.query(
                    "SELECT courier_unit_id, payment_method FROM current_orders WHERE company_id=? AND order_id=? LIMIT 1",
                    [companyId, id]
                );
                prevCourierId = prev?.courier_unit_id ?? null;
                prevPayment = prev?.payment_method ?? null;
            } catch (e) {
                console.warn("[order] read prev order failed:", e?.message ?? e);
            }

            // Неизвестный метод не должен превращать заказ в наличные:
            // оставляем то, что уже было записано.
            const payment_method = coercePaymentMethod(b.payment) ?? prevPayment ?? "cash";
            if (!coercePaymentMethod(b.payment)) {
                console.warn(
                    `[order ${id}] неизвестный способ оплаты ${JSON.stringify(b.payment)}, оставлен прежний: ${payment_method}`
                );
            }

            await ensureCompletedAtColumn();
            await pool.query(
                `UPDATE current_orders
         SET order_type=?, status=?, scheduled_at=?,
             courier_unit_id=?, pickup_unit_id=?,
             payment_method=?,
             delivery_fee=?,
             customer_name=?, customer_phone=?,
             address_street=?, address_house=?, address_building=?, address_apartment=?, address_floor=?, address_code=?, people_amount=?,
             address_lat=?, address_lng=?,
             manual_discount_percent=?,
             notes=?, items_json=?, amount_subtotal=?, amount_discount=?, amount_total=?, updated_at=NOW(),
             completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, UTC_TIMESTAMP()) ELSE completed_at END
         WHERE company_id=? AND order_id=?`,
                [
                    b.orderType || "active",
                    b.status || "new",
                    toMySQLDatetime(b.scheduledAt),
                    b.courierId || null,
                    b.pickupId || null,
                    payment_method,
                    delivery_fee,
                    b.customer,
                    b.phone,
                    b.street || null,
                    b.house || null,
                    b.building || null,
                    b.apart || null,
                    b.floor || null,
                    b.code || null,
                    b.numOfPeople || null,
                    Number.isFinite(Number(b.addressLat)) ? Number(b.addressLat) : null,
                    Number.isFinite(Number(b.addressLng)) ? Number(b.addressLng) : null,
                    manualDiscountPercent,
                    b.notes || null,
                    JSON.stringify(items),
                    amount_subtotal,
                    amount_discount,
                    amount_total,
                    b.status || "new",
                    companyId,
                    id,
                ]
            );

            const [rows] = await pool.query(
                `SELECT co.*,
                cu1.nickname AS courier_nickname,
                cu2.nickname AS pickup_nickname
         FROM current_orders co
                  LEFT JOIN users cu1 ON cu1.user_id = co.courier_unit_id
                  LEFT JOIN users cu2 ON cu2.user_id = co.pickup_unit_id
         WHERE co.company_id=? AND co.order_id=? LIMIT 1`,
                [companyId, id]
            );
            if (!rows.length)
                return res.status(404).json({ ok: false, error: "Заказ не найден" });

            const item = rowToPanelDto(rows[0]);
            res.json({ ok: true, item });

            if (typeof broadcastToAdmins === "function") {
                // courierAssigned — признак того, что заказ только что закрепили
                // за курьером (или передали другому). По нему index.js отправляет
                // адресный push, а приложение курьера даёт звук и баннер:
                // без него назначение существующего заказа проходило незаметно.
                const newCourierId = item.courierId ?? null;
                const courierAssigned =
                    newCourierId != null && String(newCourierId) !== String(prevCourierId ?? "");

                broadcastToAdmins({
                    type: "order_updated",
                    companyId,
                    order: item,
                    courierAssigned,
                    prevCourierId: prevCourierId ?? null,
                });
            }
        } catch (e) {
            const detail = e?.sqlMessage || e?.message || String(e);
            console.error("update current order:", e?.code || "", detail);
            res.status(500).json({ ok: false, error: `Ошибка сервера: ${detail}` });
        }
    });

    // PATCH /api/current-orders/:id/status  {status:'ready'|'enroute'|...}
    // Смена ТОЛЬКО статуса заказа.
    //
    // Здесь не пересчитываются суммы — и это главное. Раньше панель заказов
    // меняла статус через полный PUT /:id, а он собирает заказ заново: заново
    // считает позиции и заново подтягивает скидку клиента. Панель при этом
    // присылала applyCustomerDiscount:false, из-за чего скидка обнулялась и
    // завершённый заказ показывался по полной цене. Мобильное приложение
    // ходило своим маршрутом и суммы не трогало — поэтому там всё было верно.
    //
    // Маршрут зарегистрирован и на PUT, и на PATCH: CORS-политика сервера
    // PATCH из браузера не пропускает (methods без PATCH в index.js), поэтому
    // для веб-клиента нужен именно PUT.
    const updateStatusHandler = async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;
            const id = Number(req.params.id);
            const { status } = req.body || {};
            if (!status)
                return res.status(400).json({ ok: false, error: "Не указан статус" });
            if (!ORDER_STATUSES.includes(String(status))) {
                return res.status(400).json({
                    ok: false,
                    error: `Неизвестный статус: ${status}. Допустимо: ${ORDER_STATUSES.join(", ")}`,
                });
            }

            await ensureCompletedAtColumn();
            await pool.query(
                `UPDATE current_orders
                    SET status=?, updated_at=NOW(),
                        completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, UTC_TIMESTAMP()) ELSE completed_at END
                  WHERE company_id=? AND order_id=?`,
                [status, status, companyId, id]
            );

            const [rows] = await pool.query(
                `SELECT co.*,
                cu1.nickname AS courier_nickname,
                cu2.nickname AS pickup_nickname
         FROM current_orders co
                  LEFT JOIN users cu1 ON cu1.user_id = co.courier_unit_id
                  LEFT JOIN users cu2 ON cu2.user_id = co.pickup_unit_id
         WHERE co.company_id=? AND co.order_id=? LIMIT 1`,
                [companyId, id]
            );
            if (!rows.length) return res.json({ ok: true });

            const item = rowToPanelDto(rows[0]);
            // Отдаём заказ целиком: клиенту нужен свежий item, чтобы обновить
            // строку без перезагрузки списка.
            res.json({ ok: true, item });

            if (typeof broadcastToAdmins === "function") {
                broadcastToAdmins({ type: "order_updated", companyId, order: item });
            }
        } catch (e) {
            const detail = e?.sqlMessage || e?.message || String(e);
            console.error("update order status:", e?.code || "", detail);
            res.status(500).json({ ok: false, error: `Ошибка сервера: ${detail}` });
        }
    };

    router.put("/:id/status", updateStatusHandler);
    router.patch("/:id/status", updateStatusHandler);

    return router;
}

export default currentOrdersRouter;