// server/orderSupport.js
import pool from "./db.js";

// Берём companyId из JWT, а если его вдруг нет (старые токены) — пробуем достать из БД
async function resolveCompanyContext(req, res) {
    const u = req.user || {};
    let companyId = u.companyId ?? u.company_id ?? null;

    if (!companyId) {
        const userId = u.userId ?? u.id ?? null;
        if (!userId) {
            res.status(400).json({ ok: false, error: "Не удалось определить пользователя (нет id в токене)" });
            return null;
        }
        let rows;
        [rows] = await pool.query("SELECT company_id FROM users WHERE user_id=? LIMIT 1", [userId]);
        if (!rows.length) {
            res.status(404).json({ ok: false, error: "Пользователь не найден" });
            return null;
        }
        companyId = rows[0].company_id;
        req.user = { ...u, companyId };
    }
    return { companyId: Number(companyId) };
}

// GET /api/order-support/couriers
export async function getCouriers(req, res) {
    try {
        const ctx = await resolveCompanyContext(req, res);
        if (!ctx) return;
        const { companyId } = ctx;

        const [rows] = await pool.query(
            `SELECT unit_id, unit_nickname
         FROM company_units
        WHERE company_id=? AND unit_role='courier' AND is_active=1
        ORDER BY unit_nickname ASC`,
            [companyId]
        );

        res.json({ ok: true, items: rows.map(r => ({ id: r.unit_id, nickname: r.unit_nickname })) });
    } catch (e) {
        console.error("getCouriers error:", e);
        res.status(500).json({ ok: false, error: "Ошибка сервера" });
    }
}

// NEW: GET /api/order-support/pickup-points  (админы как “точки комплектации”)
export async function getPickupPoints(req, res) {
    try {
        const ctx = await resolveCompanyContext(req, res);
        if (!ctx) return;
        const { companyId } = ctx;

        const [rows] = await pool.query(
            `SELECT unit_id, unit_nickname
         FROM company_units
        WHERE company_id=? AND unit_role='admin' AND is_active=1
        ORDER BY unit_nickname ASC`,
            [companyId]
        );

        res.json({ ok: true, items: rows.map(r => ({ id: r.unit_id, nickname: r.unit_nickname })) });
    } catch (e) {
        console.error("getPickupPoints error:", e);
        res.status(500).json({ ok: false, error: "Ошибка сервера" });
    }
}

// GET /api/order-support/menu?q=...&limit=8
export async function searchMenuItems(req, res) {
    try {
        const ctx = await resolveCompanyContext(req, res);
        if (!ctx) return;
        const { companyId } = ctx;

        const q = (req.query.q || "").trim().toLowerCase();
        const limit = Math.min(Number(req.query.limit || 8), 50);

        let sql = `
      SELECT item_id, item_name, item_category, item_price, item_discount_percent
        FROM menu
       WHERE company_id=? AND is_active=1
    `;
        const params = [companyId];

        if (q) {
            sql += " AND (LOWER(item_name) LIKE ? OR LOWER(item_category) LIKE ?)";
            params.push(`%${q}%`, `%${q}%`);
        }

        sql += " ORDER BY item_name ASC LIMIT ?";
        params.push(limit);

        const [rows] = await pool.query(sql, params);

        res.json({
            ok: true,
            items: rows.map(r => ({
                id: r.item_id,
                name: r.item_name,
                category: r.item_category,
                price: Number(r.item_price),
                discount: Number(r.item_discount_percent) || 0,
            })),
        });
    } catch (e) {
        console.error("searchMenuItems error:", e);
        res.status(500).json({ ok: false, error: "Ошибка сервера" });
    }
}
