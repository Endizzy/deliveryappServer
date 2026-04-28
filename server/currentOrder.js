import express from "express";
import pool from "./db.js";
import crypto from "crypto";

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

function normalizeItemsAndAmounts(items, deliveryFee) {
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
    const discountCents = subtotalCents - itemsTotalCents;
    const deliveryFeeCents = toCents(deliveryFee);
    const totalCents = itemsTotalCents + deliveryFeeCents;

    // не сохраняем служебные поля в items_json
    const itemsClean = norm.map(({ _price_cents, _line_cents, ...rest }) => rest);

    return {
        items: itemsClean,
        amount_subtotal: formatCents(subtotalCents),
        amount_discount: formatCents(discountCents),
        amount_total: formatCents(totalCents),
        delivery_fee: formatCents(deliveryFeeCents),
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
        scheduledAt: r.scheduled_at,
        amountTotal: Number(r.amount_total),
        deliveryFee: Number(r.delivery_fee || 0),
        numOfPeople: Number(r.people_amount || 0),
        paymentMethod: r.payment_method,
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

function coercePaymentMethod(val) {
    const s = String(val || "").trim().toLowerCase();
    if (["cash", "наличные", "нал"].includes(s)) return "cash";
    if (["card", "карта", "банковская карта"].includes(s)) return "card";
    if (["wire", "перечислением", "безнал", "безналичный"].includes(s)) return "wire";
    return "cash";
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
                `SELECT order_id, status, order_type, customer_name, customer_phone,
                courier_unit_id, pickup_unit_id,
                address_street, address_house,
                address_building, address_apartment,
                address_floor, address_code,
                address_lat, address_lng
         FROM current_orders
         WHERE company_id=?
           AND status IN ('new','ready','enroute')
           AND address_lat IS NOT NULL AND address_lng IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 500`,
                [companyId]
            );

            res.json({ ok: true, items: rows.map(rowToMapDto) });
        } catch (e) {
            console.error("map current orders", e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    // GET /api/current-orders?tab=active|preorders|all
    router.get("/", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;
            const tab = (req.query.tab || "active").toLowerCase();

            const where = ["co.company_id=?"];
            const params = [companyId];

            if (tab === "active") {
                where.push("co.order_type='active'");
                where.push("co.status IN ('new','ready','enroute')");
            } else if (tab === "preorders") {
                where.push("co.order_type='preorder'");
                where.push("co.status NOT IN ('completed','cancelled')");
            } else if (tab === "completed") {
                where.push("co.status='completed'");
            }

            const sql = `
        SELECT co.*,
               cu1.unit_nickname AS courier_nickname,
               cu2.unit_nickname AS pickup_nickname
        FROM current_orders co
                 LEFT JOIN company_units cu1 ON cu1.unit_id = co.courier_unit_id
                 LEFT JOIN company_units cu2 ON cu2.unit_id = co.pickup_unit_id
        WHERE ${where.join(" AND ")}
        ORDER BY co.created_at DESC, co.order_id DESC
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
               cu1.unit_nickname AS courier_nickname,
               cu2.unit_nickname AS pickup_nickname
        FROM current_orders co
                 LEFT JOIN company_units cu1 ON cu1.unit_id = co.courier_unit_id
                 LEFT JOIN company_units cu2 ON cu2.unit_id = co.pickup_unit_id
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

            const { items, amount_subtotal, amount_discount, amount_total, delivery_fee } =
                normalizeItemsAndAmounts(b.selectedItems || [], b.deliveryFee);

            if (!b.customer || !b.phone)
                return res.status(400).json({ ok: false, error: "Имя и телефон обязательны" });
            if (!b.payment)
                return res.status(400).json({ ok: false, error: "Способ оплаты обязателен" });

            const orderNo = b.orderNo || `CO-${Date.now().toString().slice(-8)}`;
            const payment_method = coercePaymentMethod(b.payment);
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

            // читаем уже обновлённый заказ (с координатами)
            const [rows] = await pool.query(
                `SELECT co.*,
                cu1.unit_nickname AS courier_nickname,
                cu2.unit_nickname AS pickup_nickname
         FROM current_orders co
                  LEFT JOIN company_units cu1 ON cu1.unit_id = co.courier_unit_id
                  LEFT JOIN company_units cu2 ON cu2.unit_id = co.pickup_unit_id
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
            console.error("create current order", e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
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

            const { items, amount_subtotal, amount_discount, amount_total, delivery_fee } =
                normalizeItemsAndAmounts(b.selectedItems || [], b.deliveryFee);

            const payment_method = coercePaymentMethod(b.payment);

            await pool.query(
                `UPDATE current_orders
         SET order_type=?, status=?, scheduled_at=?,
             courier_unit_id=?, pickup_unit_id=?,
             payment_method=?,
             delivery_fee=?,
             customer_name=?, customer_phone=?,
             address_street=?, address_house=?, address_building=?, address_apartment=?, address_floor=?, address_code=?, people_amount=?,
             notes=?, items_json=?, amount_subtotal=?, amount_discount=?, amount_total=?, updated_at=NOW()
         WHERE company_id=? AND order_id=?`,
                [
                    b.orderType || "active",
                    b.status || "new",
                    b.scheduledAt || null,
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
                    b.notes || null,
                    JSON.stringify(items),
                    amount_subtotal,
                    amount_discount,
                    amount_total,
                    companyId,
                    id,
                ]
            );

            const [rows] = await pool.query(
                `SELECT co.*,
                cu1.unit_nickname AS courier_nickname,
                cu2.unit_nickname AS pickup_nickname
         FROM current_orders co
                  LEFT JOIN company_units cu1 ON cu1.unit_id = co.courier_unit_id
                  LEFT JOIN company_units cu2 ON cu2.unit_id = co.pickup_unit_id
         WHERE co.company_id=? AND co.order_id=? LIMIT 1`,
                [companyId, id]
            );
            if (!rows.length)
                return res.status(404).json({ ok: false, error: "Заказ не найден" });

            const item = rowToPanelDto(rows[0]);
            res.json({ ok: true, item });

            if (typeof broadcastToAdmins === "function") {
                broadcastToAdmins({ type: "order_updated", companyId, order: item });
            }
        } catch (e) {
            console.error("update current order", e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    // PATCH /api/current-orders/:id/status  {status:'ready'|'enroute'|...}
    router.patch("/:id/status", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;
            const id = Number(req.params.id);
            const { status } = req.body || {};
            if (!status)
                return res.status(400).json({ ok: false, error: "Не указан статус" });

            await pool.query(
                `UPDATE current_orders SET status=?, updated_at=NOW()
         WHERE company_id=? AND order_id=?`,
                [status, companyId, id]
            );

            const [rows] = await pool.query(
                `SELECT co.*,
                cu1.unit_nickname AS courier_nickname,
                cu2.unit_nickname AS pickup_nickname
         FROM current_orders co
                  LEFT JOIN company_units cu1 ON cu1.unit_id = co.courier_unit_id
                  LEFT JOIN company_units cu2 ON cu2.unit_id = co.pickup_unit_id
         WHERE co.company_id=? AND co.order_id=? LIMIT 1`,
                [companyId, id]
            );
            if (!rows.length) return res.json({ ok: true });

            const item = rowToPanelDto(rows[0]);
            res.json({ ok: true });

            if (typeof broadcastToAdmins === "function") {
                broadcastToAdmins({ type: "order_updated", companyId, order: item });
            }
        } catch (e) {
            console.error("patch status current order", e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    return router;
}

export default currentOrdersRouter;