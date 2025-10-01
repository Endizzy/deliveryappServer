// server/orderSupport.js
import pool from "./db.js";

/** Безопасный селект одной строки: если таблицы/колонки нет — вернем null, а не урони́м сервер. */
async function queryOne(sql, params = []) {
    try {
        const [rows] = await pool.query(sql, params);
        return rows?.[0] ?? null;
    } catch (e) {
        if (e?.code === "ER_NO_SUCH_TABLE" || e?.code === "ER_BAD_FIELD_ERROR") {
            return null;
        }
        throw e;
    }
}

/** Пытаемся найти company_id пользователя по разным таблицам/полям. */
async function findCompanyIdByUser({ idLike, email }) {
    const tables = ["`users`", "`user`"]; // пробуем обе
    for (const t of tables) {
        if (idLike != null) {
            let row = await queryOne(`SELECT company_id FROM ${t} WHERE id=? LIMIT 1`, [idLike]);
            if (row?.company_id) return Number(row.company_id);

            row = await queryOne(`SELECT company_id FROM ${t} WHERE user_id=? LIMIT 1`, [idLike]);
            if (row?.company_id) return Number(row.company_id);
        }
        if (email) {
            const row = await queryOne(`SELECT company_id FROM ${t} WHERE email=? LIMIT 1`, [email]);
            if (row?.company_id) return Number(row.company_id);
        }
    }
    return null;
}

/** Универсально достаем companyId. */
async function resolveCompanyContext(req, res) {
    try {
        const u = req.user || {};
        let companyId = u.companyId ?? u.company_id ?? null;
        if (!companyId) {
            const idLike = u.id ?? u.userId ?? u.user_id ?? null;
            const email = u.email ?? null;
            companyId = await findCompanyIdByUser({ idLike, email });
        }
        if (!companyId) {
            res.status(400).json({
                ok: false,
                error: "Не удалось определить companyId (проверь payload токена и таблицы users/user)",
            });
            return null;
        }
        return { companyId: Number(companyId) };
    } catch (e) {
        console.error("[resolveCompanyContext] error:", e);
        res.status(500).json({ ok: false, error: "Ошибка сервера (resolve company)" });
        return null;
    }
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

        res.json({
            ok: true,
            items: rows.map(r => ({ id: Number(r.unit_id), nickname: r.unit_nickname })),
        });
    } catch (e) {
        console.error("[getCouriers] error:", e);
        res.status(500).json({ ok: false, error: "Ошибка сервера (couriers)" });
    }
}

// GET /api/order-support/menu?q=...&limit=8
export async function searchMenuItems(req, res) {
    try {
        const ctx = await resolveCompanyContext(req, res);
        if (!ctx) return;
        const { companyId } = ctx;

        const q = String(req.query.q || "").trim().toLowerCase();
        const limit = Math.min(Math.max(parseInt(req.query.limit || "8", 10), 1), 50);

        let sql =
            `SELECT item_id, item_name, item_category, item_price, item_discount_percent
         FROM menu
        WHERE company_id=? AND is_active=1`;
        const params = [companyId];

        if (q) {
            sql += ` AND (LOWER(item_name) LIKE ? OR LOWER(item_category) LIKE ?)`;
            params.push(`%${q}%`, `%${q}%`);
        }

        sql += ` ORDER BY item_name ASC LIMIT ?`;
        params.push(limit);

        const [rows] = await pool.query(sql, params);

        res.json({
            ok: true,
            items: rows.map(r => ({
                id: Number(r.item_id),
                name: r.item_name,
                category: r.item_category,
                price: Number(r.item_price),
                discount: Number(r.item_discount_percent) || 0,
            })),
        });
    } catch (e) {
        console.error("[searchMenuItems] error:", e);
        res.status(500).json({ ok: false, error: "Ошибка сервера (menu search)" });
    }
}
