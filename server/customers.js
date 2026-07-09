import { Router } from "express";
import pool from "./db.js";
import { resolveCompanyContext } from "./currentOrder.js";

// ─────────────────────────────────────────────────────────────────────────────
// Контроль клиентов (для руководства ресторана).
// Клиент идентифицируется по customer_phone в рамках company_id.
// Данные агрегируются из current_orders. Плюс персональные скидки и рассылки.
// ─────────────────────────────────────────────────────────────────────────────

// Нормализация телефона к виду +371XXXXXXXX (как в customerAddressByPhone.js)
export function normalizePhone(phone) {
    const raw = String(phone || "").trim();
    const digits = raw.replace(/\D/g, "");
    if (!digits) return "";
    if (digits.startsWith("371")) return `+${digits}`;
    if (digits.length === 8) return `+371${digits}`;
    return raw.replace(/\s/g, "");
}

// ── Ленивая миграция таблиц ──────────────────────────────────────────────────
let _tablesReady = false;
export async function ensureCustomerTables() {
    if (_tablesReady) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS customer_discounts (
            company_id      INT           NOT NULL,
            customer_phone  VARCHAR(32)   NOT NULL,
            discount_type   ENUM('percent','fixed') NOT NULL DEFAULT 'percent',
            discount_value  DECIMAL(10,2) NOT NULL DEFAULT 0,
            note            VARCHAR(255)  NULL,
            updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (company_id, customer_phone)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS customer_broadcasts (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            company_id       INT          NOT NULL,
            message          TEXT         NOT NULL,
            recipients_count INT          NOT NULL DEFAULT 0,
            channel          VARCHAR(16)  NOT NULL DEFAULT 'sms',
            status           VARCHAR(16)  NOT NULL DEFAULT 'stubbed',
            created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_company (company_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    _tablesReady = true;
}

// Возвращает скидку клиента { type, value } или null. company-scoped.
export async function getCustomerDiscount(companyId, phoneRaw) {
    const phone = normalizePhone(phoneRaw);
    if (!phone) return null;
    await ensureCustomerTables();
    const [rows] = await pool.query(
        `SELECT discount_type, discount_value
           FROM customer_discounts
          WHERE company_id=? AND customer_phone=?
          LIMIT 1`,
        [companyId, phone]
    );
    if (!rows.length) return null;
    const value = Number(rows[0].discount_value) || 0;
    if (value <= 0) return null;
    return { type: rows[0].discount_type, value };
}

export default function createCustomersRouter() {
    const router = Router();

    // ── GET /api/customers ───────────────────────────────────────────────────
    // Агрегированный список клиентов компании: имя (последнее), телефон,
    // кол-во заказов, сумма всех заказов, первый/последний заказ, скидка.
    router.get("/", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;
            await ensureCustomerTables();

            // Агрегируем заказы по телефону. Отменённые не учитываем в сумме,
            // но считаем в total_orders отдельно (revenue берём без cancelled).
            const [rows] = await pool.query(
                `SELECT
                    o.customer_phone                                   AS phone,
                    (SELECT o2.customer_name
                       FROM current_orders o2
                      WHERE o2.company_id = ?
                        AND o2.customer_phone = o.customer_phone
                      ORDER BY o2.created_at DESC, o2.order_id DESC
                      LIMIT 1)                                         AS name,
                    COUNT(*)                                           AS orders_count,
                    SUM(CASE WHEN o.status <> 'cancelled' THEN 1 ELSE 0 END) AS paid_orders_count,
                    COALESCE(SUM(CASE WHEN o.status <> 'cancelled' THEN o.amount_total ELSE 0 END), 0) AS total_spent,
                    MIN(o.created_at)                                  AS first_order_at,
                    MAX(o.created_at)                                  AS last_order_at
                 FROM current_orders o
                 WHERE o.company_id = ?
                   AND o.customer_phone IS NOT NULL
                   AND o.customer_phone <> ''
                 GROUP BY o.customer_phone
                 ORDER BY total_spent DESC`,
                [companyId, companyId]
            );

            const [discRows] = await pool.query(
                `SELECT customer_phone, discount_type, discount_value
                   FROM customer_discounts
                  WHERE company_id=?`,
                [companyId]
            );
            const discMap = new Map(
                discRows.map((d) => [
                    d.customer_phone,
                    { type: d.discount_type, value: Number(d.discount_value) || 0 },
                ])
            );

            const items = rows.map((r) => {
                const disc = discMap.get(r.phone);
                return {
                    phone: r.phone,
                    name: r.name || "",
                    ordersCount: Number(r.orders_count) || 0,
                    paidOrdersCount: Number(r.paid_orders_count) || 0,
                    totalSpent: Number(r.total_spent) || 0,
                    firstOrderAt: r.first_order_at,
                    lastOrderAt: r.last_order_at,
                    discount: disc && disc.value > 0 ? disc : null,
                };
            });

            const summary = items.reduce(
                (acc, c) => {
                    acc.customers += 1;
                    acc.orders += c.paidOrdersCount;
                    acc.revenue += c.totalSpent;
                    return acc;
                },
                { customers: 0, orders: 0, revenue: 0 }
            );

            res.json({ ok: true, items, summary });
        } catch (e) {
            console.error("customers list error:", e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    // ── GET /api/customers/discount-by-phone?phone= ──────────────────────────
    // Лёгкий эндпоинт для CreateOrder: скидка клиента для авто-подстановки.
    router.get("/discount-by-phone", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;
            const discount = await getCustomerDiscount(companyId, req.query.phone);
            res.json({ ok: true, discount: discount || null });
        } catch (e) {
            console.error("discount-by-phone error:", e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    // ── GET /api/customers/:phone/orders ─────────────────────────────────────
    router.get("/:phone/orders", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;
            const phone = normalizePhone(req.params.phone);
            if (!phone) return res.status(400).json({ ok: false, error: "phone required" });

            const [rows] = await pool.query(
                `SELECT order_id, order_no, order_seq, status, order_type,
                        items_json, delivery_fee,
                        amount_subtotal, amount_discount, amount_total,
                        payment_method, created_at, scheduled_at, completed_at
                   FROM current_orders
                  WHERE company_id=? AND customer_phone=?
                  ORDER BY created_at DESC, order_id DESC`,
                [companyId, phone]
            );

            const parseItems = (raw) => {
                if (!raw) return [];
                try {
                    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
                    return Array.isArray(arr)
                        ? arr.map((it) => ({
                              id: it.id ?? null,
                              name: it.name ?? "",
                              price: Number(it.price) || 0,
                              discount: Number(it.discount) || 0,
                              finalPrice: Number(it.final_price ?? it.finalPrice) || 0,
                              quantity: Number(it.quantity) || 0,
                              lineTotal: Number(it.line_total ?? it.lineTotal) || 0,
                          }))
                        : [];
                } catch {
                    return [];
                }
            };

            const items = rows.map((r) => ({
                id: r.order_id,
                orderNo: r.order_no,
                orderSeq: r.order_seq,
                status: r.status,
                orderType: r.order_type,
                items: parseItems(r.items_json),
                deliveryFee: Number(r.delivery_fee) || 0,
                amountSubtotal: Number(r.amount_subtotal) || 0,
                amountDiscount: Number(r.amount_discount) || 0,
                amountTotal: Number(r.amount_total) || 0,
                paymentMethod: r.payment_method,
                createdAt: r.created_at,
                scheduledAt: r.scheduled_at,
                completedAt: r.completed_at,
            }));

            res.json({ ok: true, items });
        } catch (e) {
            console.error("customer orders error:", e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    // ── PUT /api/customers/:phone/discount ───────────────────────────────────
    // body: { type: 'percent'|'fixed', value: number, note?: string }
    router.put("/:phone/discount", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;
            await ensureCustomerTables();

            const phone = normalizePhone(req.params.phone);
            if (!phone) return res.status(400).json({ ok: false, error: "phone required" });

            const type = req.body?.type === "fixed" ? "fixed" : "percent";
            let value = Number(req.body?.value);
            if (!Number.isFinite(value) || value < 0) value = 0;
            if (type === "percent" && value > 100) value = 100;
            const note = (req.body?.note ?? "").toString().slice(0, 255) || null;

            // value=0 → удаляем скидку (нет смысла хранить нулевую)
            if (value <= 0) {
                await pool.query(
                    `DELETE FROM customer_discounts WHERE company_id=? AND customer_phone=?`,
                    [companyId, phone]
                );
                return res.json({ ok: true, discount: null });
            }

            await pool.query(
                `INSERT INTO customer_discounts (company_id, customer_phone, discount_type, discount_value, note)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE discount_type=VALUES(discount_type),
                                         discount_value=VALUES(discount_value),
                                         note=VALUES(note)`,
                [companyId, phone, type, value, note]
            );

            res.json({ ok: true, discount: { type, value, note } });
        } catch (e) {
            console.error("set discount error:", e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    // ── DELETE /api/customers/:phone/discount ────────────────────────────────
    router.delete("/:phone/discount", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;
            await ensureCustomerTables();
            const phone = normalizePhone(req.params.phone);
            if (!phone) return res.status(400).json({ ok: false, error: "phone required" });
            await pool.query(
                `DELETE FROM customer_discounts WHERE company_id=? AND customer_phone=?`,
                [companyId, phone]
            );
            res.json({ ok: true });
        } catch (e) {
            console.error("delete discount error:", e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    // ── POST /api/customers/broadcast ────────────────────────────────────────
    // body: { message: string, phones?: string[] }
    // Отправка рекламной рассылки. SMS-провайдер пока не подключён — заглушка:
    // сообщение валидируется, логируется, событие пишется в customer_broadcasts.
    router.post("/broadcast", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;
            await ensureCustomerTables();

            const message = (req.body?.message ?? "").toString().trim();
            if (!message) return res.status(400).json({ ok: false, error: "Текст сообщения обязателен" });

            // Список получателей: либо переданные телефоны, либо все клиенты компании
            let phones = Array.isArray(req.body?.phones) ? req.body.phones : null;
            if (!phones || !phones.length) {
                const [rows] = await pool.query(
                    `SELECT DISTINCT customer_phone
                       FROM current_orders
                      WHERE company_id=? AND customer_phone IS NOT NULL AND customer_phone <> ''`,
                    [companyId]
                );
                phones = rows.map((r) => r.customer_phone);
            }
            phones = [...new Set(phones.map(normalizePhone).filter(Boolean))];

            // ── SMS-ЗАГЛУШКА ─────────────────────────────────────────────────
            // TODO: подключить реального провайдера (Twilio/Textmagic/…).
            // Здесь только имитируем отправку: логируем и считаем адресатов.
            const result = await sendSmsBroadcast({ companyId, message, phones });

            await pool.query(
                `INSERT INTO customer_broadcasts (company_id, message, recipients_count, channel, status)
                 VALUES (?, ?, ?, 'sms', ?)`,
                [companyId, message, phones.length, result.status]
            );

            res.json({
                ok: true,
                sent: result.sent,
                recipients: phones.length,
                stub: result.stub,
                note: result.note,
            });
        } catch (e) {
            console.error("broadcast error:", e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    // ── GET /api/customers/broadcasts ────────────────────────────────────────
    // История рассылок компании.
    router.get("/broadcasts", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;
            await ensureCustomerTables();
            const [rows] = await pool.query(
                `SELECT id, message, recipients_count, channel, status, created_at
                   FROM customer_broadcasts
                  WHERE company_id=?
                  ORDER BY created_at DESC
                  LIMIT 50`,
                [companyId]
            );
            res.json({
                ok: true,
                items: rows.map((r) => ({
                    id: r.id,
                    message: r.message,
                    recipientsCount: r.recipients_count,
                    channel: r.channel,
                    status: r.status,
                    createdAt: r.created_at,
                })),
            });
        } catch (e) {
            console.error("broadcasts list error:", e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    return router;
}

// ─────────────────────────────────────────────────────────────────────────────
// SMS-заглушка. Когда появится номер и провайдер — заменить тело функции
// реальным вызовом API (см. TODO). Сейчас возвращает stub-результат.
// ─────────────────────────────────────────────────────────────────────────────
async function sendSmsBroadcast({ companyId, message, phones }) {
    console.log(
        `[sms-stub] company=${companyId} recipients=${phones.length} message="${message.slice(0, 60)}${message.length > 60 ? "…" : ""}"`
    );
    return {
        stub: true,
        sent: 0, // реально ничего не отправлено
        status: "stubbed",
        note: "SMS-провайдер не настроен. Сообщение подготовлено, но не отправлено.",
    };
}
