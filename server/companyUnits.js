import pool from "./db.js";
import bcrypt from "bcrypt";

const SALT_ROUNDS = 10;

// Палитра цветов курьеров
const COLOR_PALETTE = [
    "#2F8CFF", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6",
    "#EC4899", "#14B8A6", "#F97316", "#6366F1", "#84CC16",
];
const isHexColor = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
const randomColor = () => COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];

// Ленивая авто-миграция колонки color (выполняется один раз)
let _colorReady = false;
export async function ensureColorColumn() {
    if (_colorReady) return;
    try {
        const [rows] = await pool.query(
            `SELECT COUNT(*) AS c FROM information_schema.columns
              WHERE table_schema = DATABASE()
                AND table_name = 'company_units'
                AND column_name = 'color'`
        );
        if (!rows.length || Number(rows[0].c) === 0) {
            await pool.query(`ALTER TABLE company_units ADD COLUMN color VARCHAR(16) NULL`);
        }
        _colorReady = true;
    } catch (e) {
        console.warn("ensureColorColumn failed:", e?.message || e);
    }
}

// Приводим строку результата из БД к фронтовому формату
const mapUnit = (r) => ({
    id: r.unit_id,
    companyId: r.company_id,
    nickname: r.unit_nickname,
    phone: r.unit_phone,
    email: r.unit_email,
    role: r.unit_role,
    color: r.color || null,
    active: !!r.is_active,
    lastEnter: r.unit_last_enter,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

// Нормализуем поля пользователя, пришедшие из authMiddleware/JWT
function normalizeUser(u = {}) {
    const companyId =
        u.companyId ?? u.company_id ?? u.company ?? u.companyID ?? null;
    const role = (u.role || u.user_role || "").toLowerCase();
    const userId = u.userId ?? u.id ?? u.user_id ?? null;
    return { ...u, companyId: companyId ? Number(companyId) : null, role, userId };
}

// Если в req.user нет companyId/role — добираем из БД
async function requireCompanyContext(req, res) {
    const base = normalizeUser(req.user || {});
    let { companyId, role, userId } = base;

    if (!companyId || !role) {
        if (!userId) {
            res.status(400).json({ ok: false, error: "Нет userId у токена" });
            return null;
        }
        const [rows] = await pool.query(
            "SELECT company_id, role FROM users WHERE user_id = ? LIMIT 1",
            [userId]
        );
        if (!rows.length) {
            res.status(404).json({ ok: false, error: "Пользователь не найден" });
            return null;
        }
        companyId = companyId ?? rows[0].company_id;
        role = role || rows[0].role;
        // чтобы дальше по пайплайну было в req.user
        req.user = { ...req.user, companyId, role, userId };
    }

    if (!companyId) {
        res.status(400).json({ ok: false, error: "У пользователя нет companyId" });
        return null;
    }
    if (String(role).toLowerCase() === "courier") {
        res.status(403).json({ ok: false, error: "Недостаточно прав" });
        return null;
    }
    return { companyId: Number(companyId), role: String(role).toLowerCase() };
}

// ------- CRUD --------

export async function listUnits(req, res) {
    try {
        const ctx = await requireCompanyContext(req, res);
        if (!ctx) return;
        const { companyId } = ctx;

        await ensureColorColumn();

        const q = (req.query.q || "").trim().toLowerCase();
        let sql =
            "SELECT * FROM company_units WHERE company_id = ? ORDER BY unit_id DESC";
        let params = [companyId];

        if (q) {
            sql =
                "SELECT * FROM company_units " +
                "WHERE company_id = ? AND (LOWER(unit_nickname) LIKE ? OR LOWER(unit_phone) LIKE ? OR LOWER(unit_role) LIKE ?) " +
                "ORDER BY unit_id DESC";
            params = [companyId, `%${q}%`, `%${q}%`, `%${q}%`];
        }

        const [rows] = await pool.query(sql, params);
        res.json({ ok: true, items: rows.map(mapUnit) });
    } catch (e) {
        console.error("listUnits error:", e);
        res.status(500).json({ ok: false, error: "Ошибка сервера" });
    }
}

export async function createUnit(req, res) {
    try {
        const ctx = await requireCompanyContext(req, res);
        if (!ctx) return;
        const { companyId } = ctx;

        const {
            nickname,
            phone,
            email = null,
            role = "courier",
            password,
            active = true,
            color,
        } = req.body || {};

        if (!nickname || !phone || !password) {
            return res
                .status(400)
                .json({ ok: false, error: "nickname, phone и password обязательны" });
        }
        if (!["courier", "admin"].includes(String(role)))
            return res.status(400).json({ ok: false, error: "Некорректная роль" });

        await ensureColorColumn();
        // цвет курьера: переданный (если валиден) или случайный из палитры
        const finalColor = isHexColor(color) ? color : randomColor();

        const hash = await bcrypt.hash(String(password), SALT_ROUNDS);

        const [result] = await pool.query(
            `INSERT INTO company_units
             (company_id, unit_nickname, unit_phone, unit_email, unit_role, unit_password_hash, is_active, color)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [companyId, nickname, phone, email, role, hash, active ? 1 : 0, finalColor]
        );

        const [rows] = await pool.query(
            "SELECT * FROM company_units WHERE unit_id = ? AND company_id = ?",
            [result.insertId, companyId]
        );
        res.status(201).json({ ok: true, item: mapUnit(rows[0]) });
    } catch (e) {
        if (e && e.code === "ER_DUP_ENTRY") {
            return res
                .status(409)
                .json({ ok: false, error: "Ник/телефон/email уже заняты в этой компании" });
        }
        console.error("createUnit error:", e);
        res.status(500).json({ ok: false, error: "Ошибка сервера" });
    }
}

export async function updateUnit(req, res) {
    try {
        const ctx = await requireCompanyContext(req, res);
        if (!ctx) return;
        const { companyId } = ctx;

        const id = Number(req.params.id);
        const { nickname, phone, email, role, active, password, color } = req.body || {};

        await ensureColorColumn();

        const fields = [];
        const params = [];

        if (nickname !== undefined) { fields.push("unit_nickname=?"); params.push(nickname); }
        if (phone !== undefined)    { fields.push("unit_phone=?");    params.push(phone); }
        if (email !== undefined)    { fields.push("unit_email=?");    params.push(email || null); }
        if (color !== undefined && isHexColor(color)) { fields.push("color=?"); params.push(color); }
        if (role !== undefined) {
            if (!["courier", "admin"].includes(String(role)))
                return res.status(400).json({ ok: false, error: "Некорректная роль" });
            fields.push("unit_role=?"); params.push(role);
        }
        if (active !== undefined)   { fields.push("is_active=?");     params.push(active ? 1 : 0); }
        if (password) {
            const hash = await bcrypt.hash(String(password), SALT_ROUNDS);
            fields.push("unit_password_hash=?");
            params.push(hash);
        }

        if (!fields.length) return res.json({ ok: true, item: null });

        const sql =
            `UPDATE company_units SET ${fields.join(", ")}, updated_at=CURRENT_TIMESTAMP
             WHERE unit_id=? AND company_id=?`;
        params.push(id, companyId);

        const [result] = await pool.query(sql, params);
        if (result.affectedRows === 0)
            return res.status(404).json({ ok: false, error: "Не найдено" });

        const [rows] = await pool.query(
            "SELECT * FROM company_units WHERE unit_id=? AND company_id=?",
            [id, companyId]
        );
        res.json({ ok: true, item: rows.length ? mapUnit(rows[0]) : null });
    } catch (e) {
        if (e && e.code === "ER_DUP_ENTRY") {
            return res
                .status(409)
                .json({ ok: false, error: "Ник/телефон/email уже заняты в этой компании" });
        }
        console.error("updateUnit error:", e);
        res.status(500).json({ ok: false, error: "Ошибка сервера" });
    }
}

export async function deleteUnit(req, res) {
    try {
        const ctx = await requireCompanyContext(req, res);
        if (!ctx) return;
        const { companyId } = ctx;

        const id = Number(req.params.id);

        const [result] = await pool.query(
            "DELETE FROM company_units WHERE unit_id=? AND company_id=?",
            [id, companyId]
        );
        if (result.affectedRows === 0)
            return res.status(404).json({ ok: false, error: "Не найдено" });

        res.json({ ok: true });
    } catch (e) {
        console.error("deleteUnit error:", e);
        res.status(500).json({ ok: false, error: "Ошибка сервера" });
    }
}
