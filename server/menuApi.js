import { Router } from "express";
import pool from "./db.js";

const router = Router();

/** Хелпер: получить company_id текущего пользователя по user_id из JWT */
async function requireCompanyId(userId) {
    const [rows] = await pool.query(
        "SELECT company_id FROM users WHERE user_id = ? LIMIT 1",
        [userId]
    );
    if (!rows.length || rows[0].company_id == null) {
        const err = new Error("NO_COMPANY");
        err.code = "NO_COMPANY";
        throw err;
    }
    return rows[0].company_id;
}

/** Привести строку меню БД к удобному JSON для фронта */
function rowToItem(r) {
    return {
        id: r.item_id,
        name: r.item_name,
        category: r.item_category,
        price: Number(r.item_price),
        discount: Number(r.item_discount_percent),
        available: !!r.is_active,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

/**
 * GET /api/menu
 * Параметры (опционально):
 *   q       — поиск по префиксу в name/category
 *   active  — true/false (если передан)
 */
router.get("/", async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "Нет токена" });

        const companyId = await requireCompanyId(userId);

        const { q, active } = req.query;
        const where = ["company_id = ?"];
        const params = [companyId];

        if (typeof q === "string" && q.trim()) {
            where.push("(item_name LIKE ? OR item_category LIKE ?)");
            params.push(`${q}%`, `${q}%`); // префиксный LIKE для индекса
        }

        if (typeof active !== "undefined") {
            const v =
                String(active).toLowerCase() === "true" ||
                String(active) === "1" ||
                active === true;
            where.push("is_active = ?");
            params.push(v ? 1 : 0);
        }

        const sql = `
      SELECT item_id, item_name, item_category, item_price,
             item_discount_percent, is_active, created_at, updated_at
      FROM menu
      WHERE ${where.join(" AND ")}
      ORDER BY item_name ASC
    `;
        const [rows] = await pool.query(sql, params);
        return res.json({ ok: true, items: rows.map(rowToItem) });
    } catch (err) {
        if (err.code === "NO_COMPANY")
            return res.status(400).json({ error: "У пользователя не указан company_id" });
        console.error("GET /api/menu error:", err);
        return res.status(500).json({ error: "Ошибка сервера" });
    }
});

/** POST /api/menu — создать позицию */
router.post("/", async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "Нет токена" });
        const companyId = await requireCompanyId(userId);

        const { name, category, price, discount = 0, available = true } = req.body || {};
        if (!name || typeof price === "undefined" || price === "")
            return res.status(400).json({ error: "name и price обязательны" });

        const p = Number(price);
        const d = Number(discount);
        if (Number.isNaN(p) || p < 0) return res.status(400).json({ error: "Некорректная цена" });
        if (Number.isNaN(d) || d < 0 || d > 100) return res.status(400).json({ error: "Скидка 0..100" });

        const [result] = await pool.query(
            `INSERT INTO menu
       (company_id, item_name, item_category, item_price, item_discount_percent, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [companyId, name, category || null, p, d, available ? 1 : 0]
        );

        const [rows] = await pool.query(
            `SELECT item_id, item_name, item_category, item_price, item_discount_percent, is_active, created_at, updated_at
         FROM menu WHERE item_id = ? AND company_id = ? LIMIT 1`,
            [result.insertId, companyId]
        );

        return res.json({ ok: true, item: rowToItem(rows[0]) });
    } catch (err) {
        if (err.code === "NO_COMPANY")
            return res.status(400).json({ error: "У пользователя не указан company_id" });
        console.error("POST /api/menu error:", err);
        return res.status(500).json({ error: "Ошибка сервера" });
    }
});

/** PUT /api/menu/:id — обновить позицию */
router.put("/:id", async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "Нет токена" });
        const companyId = await requireCompanyId(userId);

        const itemId = Number(req.params.id);
        if (!itemId) return res.status(400).json({ error: "Некорректный id" });

        const { name, category, price, discount, available } = req.body || {};

        const sets = [];
        const params = [];

        if (typeof name !== "undefined") { sets.push("item_name = ?"); params.push(name); }
        if (typeof category !== "undefined") { sets.push("item_category = ?"); params.push(category || null); }
        if (typeof price !== "undefined") {
            const p = Number(price);
            if (Number.isNaN(p) || p < 0) return res.status(400).json({ error: "Некорректная цена" });
            sets.push("item_price = ?"); params.push(p);
        }
        if (typeof discount !== "undefined") {
            const d = Number(discount);
            if (Number.isNaN(d) || d < 0 || d > 100) return res.status(400).json({ error: "Скидка 0..100" });
            sets.push("item_discount_percent = ?"); params.push(d);
        }
        if (typeof available !== "undefined") { sets.push("is_active = ?"); params.push(available ? 1 : 0); }

        if (sets.length === 0) return res.status(400).json({ error: "Нечего обновлять" });

        const sql = `
      UPDATE menu
         SET ${sets.join(", ")}, updated_at = NOW()
       WHERE item_id = ? AND company_id = ?
       LIMIT 1
    `;
        params.push(itemId, companyId);
        const [upd] = await pool.query(sql, params);
        if (upd.affectedRows === 0) return res.status(404).json({ error: "Не найдено" });

        const [rows] = await pool.query(
            `SELECT item_id, item_name, item_category, item_price, item_discount_percent, is_active, created_at, updated_at
         FROM menu WHERE item_id = ? AND company_id = ? LIMIT 1`,
            [itemId, companyId]
        );

        return res.json({ ok: true, item: rowToItem(rows[0]) });
    } catch (err) {
        if (err.code === "NO_COMPANY")
            return res.status(400).json({ error: "У пользователя не указан company_id" });
        console.error("PUT /api/menu/:id error:", err);
        return res.status(500).json({ error: "Ошибка сервера" });
    }
});

/** DELETE /api/menu/:id — удалить позицию */
router.delete("/:id", async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "Нет токена" });
        const companyId = await requireCompanyId(userId);

        const itemId = Number(req.params.id);
        if (!itemId) return res.status(400).json({ error: "Некорректный id" });

        const [del] = await pool.query(
            `DELETE FROM menu WHERE item_id = ? AND company_id = ? LIMIT 1`,
            [itemId, companyId]
        );
        if (del.affectedRows === 0) return res.status(404).json({ error: "Не найдено" });

        return res.json({ ok: true });
    } catch (err) {
        if (err.code === "NO_COMPANY")
            return res.status(400).json({ error: "У пользователя не указан company_id" });
        console.error("DELETE /api/menu/:id error:", err);
        return res.status(500).json({ error: "Ошибка сервера" });
    }
});

export default router;
