import { Router } from "express";
import pool from "./db.js";

const router = Router();

function parseMoneyToCents(value) {
    if (value == null) return { ok: false, error: "Некорректная цена" };
    const s = typeof value === "string" ? value.trim().replace(",", ".") : value;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "Некорректная цена" };
    const cents = Math.round((n + Number.EPSILON) * 100);
    return { ok: true, cents };
}

function centsToMoneyString(cents) {
    return (Math.round(Number(cents) || 0) / 100).toFixed(2);
}

function parsePercent(value) {
    if (value == null || value === "") return { ok: true, value: 0 };
    const s = typeof value === "string" ? value.trim().replace(",", ".") : value;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, error: "Скидка 0..100" };
    return { ok: true, value: Math.round((n + Number.EPSILON) * 100) / 100 };
}

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

        const pm = parseMoneyToCents(price);
        if (!pm.ok) return res.status(400).json({ error: pm.error });
        const pd = parsePercent(discount);
        if (!pd.ok) return res.status(400).json({ error: pd.error });

        const p = centsToMoneyString(pm.cents);
        const d = pd.value;

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
// ═══════════════════════════════════════════════════════════════════════════
//  Категории меню
//
//  Категории — отдельная сущность (таблица menu_categories), но позиции
//  по-прежнему хранят название категории текстом в menu.item_category.
//  Так создание заказа, поиск позиций и мобильное приложение продолжают
//  работать без изменений, а связь поддерживается при переименовании.
//
//  ВАЖНО: маршруты объявлены ДО "/:id", иначе Express попытается принять
//  "categories" за идентификатор позиции.
// ═══════════════════════════════════════════════════════════════════════════

function normalizeCategoryName(value) {
    const name = String(value ?? "").trim().replace(/\s+/g, " ");
    if (!name) return { ok: false, error: "Название категории обязательно" };
    if (name.length > 120) return { ok: false, error: "Название слишком длинное" };
    return { ok: true, name };
}

/** GET /api/menu/categories — категории компании со счётчиком позиций */
router.get("/categories", async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "Нет токена" });
        const companyId = await requireCompanyId(userId);

        const [rows] = await pool.query(
            `SELECT c.category_id, c.name, c.sort_order,
                    (SELECT COUNT(*) FROM menu m
                      WHERE m.company_id = c.company_id
                        AND m.item_category = c.name) AS items_count
               FROM menu_categories c
              WHERE c.company_id = ?
              ORDER BY c.sort_order ASC, c.name ASC`,
            [companyId]
        );

        return res.json({
            ok: true,
            categories: rows.map((r) => ({
                id: r.category_id,
                name: r.name,
                sortOrder: r.sort_order,
                itemsCount: Number(r.items_count) || 0,
            })),
        });
    } catch (err) {
        if (err.code === "NO_COMPANY")
            return res.status(400).json({ error: "У пользователя не указан company_id" });
        console.error("GET /api/menu/categories error:", err?.sqlMessage || err);
        return res.status(500).json({ error: err?.sqlMessage || "Ошибка сервера" });
    }
});

/** POST /api/menu/categories — создать категорию */
router.post("/categories", async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "Нет токена" });
        const companyId = await requireCompanyId(userId);

        const parsed = normalizeCategoryName(req.body?.name);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });

        // новая категория встаёт в конец списка вкладок
        const [[maxRow]] = await pool.query(
            "SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM menu_categories WHERE company_id = ?",
            [companyId]
        );

        const [result] = await pool.query(
            "INSERT INTO menu_categories (company_id, name, sort_order) VALUES (?, ?, ?)",
            [companyId, parsed.name, Number(maxRow.max_order) + 1]
        );

        return res.json({
            ok: true,
            category: {
                id: result.insertId,
                name: parsed.name,
                sortOrder: Number(maxRow.max_order) + 1,
                itemsCount: 0,
            },
        });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY")
            return res.status(409).json({ error: "Такая категория уже есть" });
        if (err.code === "NO_COMPANY")
            return res.status(400).json({ error: "У пользователя не указан company_id" });
        console.error("POST /api/menu/categories error:", err?.sqlMessage || err);
        return res.status(500).json({ error: err?.sqlMessage || "Ошибка сервера" });
    }
});

/**
 * PUT /api/menu/categories/:id — переименовать категорию.
 * Позиции хранят название текстом, поэтому переименование обязано обновить
 * их одной транзакцией — иначе позиции «потеряют» свою категорию.
 */
router.put("/categories/:id", async (req, res) => {
    let conn;
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "Нет токена" });
        const companyId = await requireCompanyId(userId);

        const categoryId = Number(req.params.id);
        if (!categoryId) return res.status(400).json({ error: "Некорректный id" });

        const parsed = normalizeCategoryName(req.body?.name);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });

        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [[current]] = await conn.query(
            "SELECT name FROM menu_categories WHERE category_id = ? AND company_id = ? LIMIT 1",
            [categoryId, companyId]
        );
        if (!current) {
            await conn.rollback();
            return res.status(404).json({ error: "Категория не найдена" });
        }

        if (current.name !== parsed.name) {
            await conn.query(
                "UPDATE menu_categories SET name = ? WHERE category_id = ? AND company_id = ?",
                [parsed.name, categoryId, companyId]
            );
            await conn.query(
                "UPDATE menu SET item_category = ?, updated_at = NOW() WHERE company_id = ? AND item_category = ?",
                [parsed.name, companyId, current.name]
            );
        }

        await conn.commit();
        return res.json({ ok: true, category: { id: categoryId, name: parsed.name } });
    } catch (err) {
        if (conn) { try { await conn.rollback(); } catch {} }
        if (err.code === "ER_DUP_ENTRY")
            return res.status(409).json({ error: "Такая категория уже есть" });
        console.error("PUT /api/menu/categories/:id error:", err?.sqlMessage || err);
        return res.status(500).json({ error: err?.sqlMessage || "Ошибка сервера" });
    } finally {
        if (conn) conn.release();
    }
});

/**
 * DELETE /api/menu/categories/:id — удалить категорию.
 * Позиции НЕ удаляем: у них снимается категория. Терять товары из-за
 * удаления вкладки недопустимо.
 */
router.delete("/categories/:id", async (req, res) => {
    let conn;
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "Нет токена" });
        const companyId = await requireCompanyId(userId);

        const categoryId = Number(req.params.id);
        if (!categoryId) return res.status(400).json({ error: "Некорректный id" });

        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [[current]] = await conn.query(
            "SELECT name FROM menu_categories WHERE category_id = ? AND company_id = ? LIMIT 1",
            [categoryId, companyId]
        );
        if (!current) {
            await conn.rollback();
            return res.status(404).json({ error: "Категория не найдена" });
        }

        const [upd] = await conn.query(
            "UPDATE menu SET item_category = NULL, updated_at = NOW() WHERE company_id = ? AND item_category = ?",
            [companyId, current.name]
        );
        await conn.query(
            "DELETE FROM menu_categories WHERE category_id = ? AND company_id = ?",
            [categoryId, companyId]
        );

        await conn.commit();
        return res.json({ ok: true, clearedItems: upd.affectedRows });
    } catch (err) {
        if (conn) { try { await conn.rollback(); } catch {} }
        console.error("DELETE /api/menu/categories/:id error:", err?.sqlMessage || err);
        return res.status(500).json({ error: err?.sqlMessage || "Ошибка сервера" });
    } finally {
        if (conn) conn.release();
    }
});

/** PUT /api/menu/categories-order — порядок вкладок: { ids: [id, ...] } */
router.put("/categories-order", async (req, res) => {
    let conn;
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "Нет токена" });
        const companyId = await requireCompanyId(userId);

        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
        if (!ids.length) return res.status(400).json({ error: "Пустой список" });

        conn = await pool.getConnection();
        await conn.beginTransaction();
        for (let i = 0; i < ids.length; i += 1) {
            await conn.query(
                "UPDATE menu_categories SET sort_order = ? WHERE category_id = ? AND company_id = ?",
                [i, ids[i], companyId]
            );
        }
        await conn.commit();
        return res.json({ ok: true });
    } catch (err) {
        if (conn) { try { await conn.rollback(); } catch {} }
        console.error("PUT /api/menu/categories-order error:", err?.sqlMessage || err);
        return res.status(500).json({ error: err?.sqlMessage || "Ошибка сервера" });
    } finally {
        if (conn) conn.release();
    }
});

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
            const pm = parseMoneyToCents(price);
            if (!pm.ok) return res.status(400).json({ error: pm.error });
            sets.push("item_price = ?"); params.push(centsToMoneyString(pm.cents));
        }
        if (typeof discount !== "undefined") {
            const pd = parsePercent(discount);
            if (!pd.ok) return res.status(400).json({ error: pd.error });
            sets.push("item_discount_percent = ?"); params.push(pd.value);
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
