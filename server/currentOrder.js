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

function normalizeItemsAndAmounts(items) {
    const norm = (Array.isArray(items) ? items : []).map((it) => {
        const price = Number(it.price || 0);
        const discount = Number(it.discount || 0);
        const qty = Number(it.quantity || 0);
        const final_price = +(price * (1 - discount / 100)).toFixed(2);
        const line_total = +(final_price * qty).toFixed(2);
        return {
            id: it.id ?? null,
            name: it.name ?? "",
            price,
            discount,
            final_price,
            quantity: qty,
            line_total,
        };
    });

    const subtotal = +norm.reduce((s, r) => s + r.price * r.quantity, 0).toFixed(2);
    const total    = +norm.reduce((s, r) => s + r.line_total, 0).toFixed(2);
    const discount = +(subtotal - total).toFixed(2);

    return {
        items: norm,
        amount_subtotal: subtotal,
        amount_discount: discount,
        amount_total: total,
    };
}

function rowToPanelDto(r) {
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
        orderType: r.order_type,               // 'active' | 'preorder'
        status: r.status,                      // 'new' | 'ready' | 'enroute' | 'paused' | 'cancelled'
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        scheduledAt: r.scheduled_at,
        amountTotal: Number(r.amount_total),
        paymentMethod: r.payment_method,       // 'cash' | 'card' | 'wire'
        customer: r.customer_name,
        phone: r.customer_phone,
        address: addr,
        pickupName: r.pickup_nickname || "",
        courierName: r.courier_nickname || "",
        dispatcherUnitId: r.dispatcher_unit_id,
        pickupId: r.pickup_unit_id,
        courierId: r.courier_unit_id,
    };
}

function safeParseItemsJSON(v) {
    try {
        if (v == null) return [];
        if (typeof v === "string") return JSON.parse(v);
        if (Buffer.isBuffer(v)) return JSON.parse(v.toString("utf8"));
        if (typeof v === "object") return v; // mysql2 может уже отдать объект
        return [];
    } catch {
        return [];
    }
}

function coercePaymentMethod(val) {
    // приводим к ENUM: 'cash','card','wire'
    const s = String(val || "").trim().toLowerCase();
    if (["cash", "наличные", "нал"].includes(s)) return "cash";
    if (["card", "карта", "банковская карта"].includes(s)) return "card";
    if (["wire", "перечислением", "безнал", "безналичный"].includes(s)) return "wire";
    return "cash";
}

/** Определяем «операционный день» для нумерации */
export function deriveOrderSeqDate(orderType, scheduledAt) {
    // если предзаказ и есть дата — нумеруем на ту дату; иначе — по текущей дате создания
    if (orderType === "preorder" && scheduledAt) {
        const d = new Date(scheduledAt);
        // YYYY-MM-DD
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

/** --- router factory (инжектим broadcastToAdmins из index.js) --- */
export function currentOrdersRouter({ broadcastToAdmins }) {
    const router = express.Router();

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
                where.push("co.status IN ('new','ready','enroute','paused')");
            } else if (tab === "preorders") {
                where.push("co.order_type='preorder'");
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
            dto.addressStreet    = r.address_street;
            dto.addressHouse     = r.address_house;
            dto.addressBuilding  = r.address_building;
            dto.addressApartment = r.address_apartment;
            dto.addressFloor     = r.address_floor;
            dto.addressCode      = r.address_code;

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

            const {
                items,
                amount_subtotal,
                amount_discount,
                amount_total,
            } = normalizeItemsAndAmounts(b.selectedItems || []);

            if (!b.customer || !b.phone)
                return res.status(400).json({ ok: false, error: "Имя и телефон обязательны" });
            if (!b.payment)
                return res.status(400).json({ ok: false, error: "Способ оплаты обязателен" });

            const orderNo = b.orderNo || `CO-${Date.now().toString().slice(-8)}`;
            const payment_method = coercePaymentMethod(b.payment);
            const order_type = b.orderType || "active";
            const scheduled_at = b.scheduledAt || null;

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
              customer_name, customer_phone,
              address_street, address_house, address_building, address_apartment, address_floor, address_code,
              notes,
              items_json, amount_subtotal, amount_discount, amount_total)
             VALUES
             (?, ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?,
              ?,
              ?, ?,
              ?, ?, ?, ?, ?, ?,
              ?,
              ?, ?, ?, ?)`,
                        [
                            companyId, orderNo, nextSeq, order_seq_date,
                            order_type, b.status || "new", scheduled_at,
                            b.courierId || null, b.pickupId || null, (user && user.unitId) || null,
                            payment_method,
                            b.customer, b.phone,
                            b.street || null, b.house || null, b.building || null, b.apart || null, b.floor || null, b.code || null,
                            b.notes || null,
                            JSON.stringify(items), amount_subtotal, amount_discount, amount_total
                        ]
                    );

                    await conn.commit();
                    result = ins;
                    break; // успех
                } catch (e) {
                    await conn.rollback();
                    // гонка: кто-то вставил с этим же номером — повторим
                    if (e && e.code === "ER_DUP_ENTRY" && attempts < 5) {
                        await new Promise(r => setTimeout(r, 10 + Math.random() * 40));
                        continue;
                    }
                    throw e;
                }
            }

            const order_id = result.insertId;

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
                    order: item,
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

            const {
                items,
                amount_subtotal,
                amount_discount,
                amount_total,
            } = normalizeItemsAndAmounts(b.selectedItems || []);

            const payment_method = coercePaymentMethod(b.payment);

            await pool.query(
                `UPDATE current_orders
                 SET order_type=?, status=?, scheduled_at=?,
                     courier_unit_id=?, pickup_unit_id=?,
                     payment_method=?,
                     customer_name=?, customer_phone=?,
                     address_street=?, address_house=?, address_building=?, address_apartment=?, address_floor=?, address_code=?,
                     notes=?, items_json=?, amount_subtotal=?, amount_discount=?, amount_total=?, updated_at=NOW()
                 WHERE company_id=? AND order_id=?`,
                [
                    b.orderType || "active",
                    b.status || "new",
                    b.scheduledAt || null,
                    b.courierId || null,
                    b.pickupId || null,
                    payment_method,
                    b.customer,
                    b.phone,
                    b.street || null,
                    b.house || null,
                    b.building || null,
                    b.apart || null,
                    b.floor || null,
                    b.code || null,
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
