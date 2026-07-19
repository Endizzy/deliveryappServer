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

// Персонал компании (курьеры и админы) теперь хранится в общей таблице users
// (role IN ('admin','courier')). Логины owner/admin/courier/client — одна identity.
const STAFF_ROLES = ["admin", "courier"];

// Приводим строку users к фронтовому формату (совместимо со старым mapUnit)
const mapUnit = (r) => ({
    id: r.user_id,
    companyId: r.company_id,
    nickname: r.nickname,
    phone: r.phone,
    email: r.email,
    role: r.role,
    color: r.color || null,
    active: !!r.is_active,
    lastEnter: r.last_enter,
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

// Проверка уникальности ника/телефона/email в рамках компании
// (в users нет UNIQUE-ключей, поэтому валидируем на уровне приложения).
async function findConflict(companyId, { nickname, phone, email }, excludeUserId = null) {
    const clauses = [];
    const params = [];
    if (nickname) { clauses.push("nickname = ?"); params.push(nickname); }
    if (phone) { clauses.push("phone = ?"); params.push(phone); }
    if (email) { clauses.push("email = ?"); params.push(email); }
    if (!clauses.length) return null;

    let sql = `SELECT user_id FROM users WHERE company_id = ? AND (${clauses.join(" OR ")})`;
    const p = [companyId, ...params];
    if (excludeUserId) { sql += " AND user_id <> ?"; p.push(excludeUserId); }
    sql += " LIMIT 1";

    const [rows] = await pool.query(sql, p);
    return rows[0] || null;
}

// ------- CRUD --------

export async function listUnits(req, res) {
    try {
        const ctx = await requireCompanyContext(req, res);
        if (!ctx) return;
        const { companyId } = ctx;

        const q = (req.query.q || "").trim().toLowerCase();
        let sql =
            `SELECT * FROM users
              WHERE company_id = ? AND role IN ('admin','courier')
              ORDER BY user_id DESC`;
        let params = [companyId];

        if (q) {
            sql =
                `SELECT * FROM users
                  WHERE company_id = ? AND role IN ('admin','courier')
                    AND (LOWER(nickname) LIKE ? OR LOWER(phone) LIKE ? OR LOWER(role) LIKE ?)
                  ORDER BY user_id DESC`;
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
        if (!STAFF_ROLES.includes(String(role)))
            return res.status(400).json({ ok: false, error: "Некорректная роль" });

        const emailVal = email || null;
        const conflict = await findConflict(companyId, { nickname, phone, email: emailVal });
        if (conflict) {
            return res
                .status(409)
                .json({ ok: false, error: "Ник/телефон/email уже заняты в этой компании" });
        }

        // цвет курьера: переданный (если валиден) или случайный из палитры
        const finalColor = isHexColor(color) ? color : randomColor();
        const hash = await bcrypt.hash(String(password), SALT_ROUNDS);

        // first_name/last_name NOT NULL: имя = ник, фамилия пустая
        const [result] = await pool.query(
            `INSERT INTO users
             (first_name, last_name, nickname, phone, email, role, password, is_active, color, company_id, created_at, updated_at)
             VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [nickname, nickname, phone, emailVal, role, hash, active ? 1 : 0, finalColor, companyId]
        );

        const [rows] = await pool.query(
            "SELECT * FROM users WHERE user_id = ? AND company_id = ?",
            [result.insertId, companyId]
        );
        res.status(201).json({ ok: true, item: mapUnit(rows[0]) });
    } catch (e) {
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

        if (role !== undefined && !STAFF_ROLES.includes(String(role))) {
            return res.status(400).json({ ok: false, error: "Некорректная роль" });
        }

        // проверка уникальности при смене ника/телефона/email
        if (nickname !== undefined || phone !== undefined || email !== undefined) {
            const conflict = await findConflict(
                companyId,
                {
                    nickname: nickname !== undefined ? nickname : null,
                    phone: phone !== undefined ? phone : null,
                    email: email !== undefined ? (email || null) : null,
                },
                id
            );
            if (conflict) {
                return res
                    .status(409)
                    .json({ ok: false, error: "Ник/телефон/email уже заняты в этой компании" });
            }
        }

        const fields = [];
        const params = [];

        if (nickname !== undefined) {
            fields.push("nickname=?"); params.push(nickname);
            // держим отображаемое имя в синхроне
            fields.push("first_name=?"); params.push(nickname);
        }
        if (phone !== undefined)    { fields.push("phone=?"); params.push(phone); }
        if (email !== undefined)    { fields.push("email=?"); params.push(email || null); }
        if (color !== undefined && isHexColor(color)) { fields.push("color=?"); params.push(color); }
        if (role !== undefined)     { fields.push("role=?"); params.push(role); }
        if (active !== undefined)   { fields.push("is_active=?"); params.push(active ? 1 : 0); }
        if (password) {
            const hash = await bcrypt.hash(String(password), SALT_ROUNDS);
            fields.push("password=?"); params.push(hash);
        }

        if (!fields.length) return res.json({ ok: true, item: null });

        // WHERE ограничен персоналом — owner/client через этот эндпоинт не трогаем
        const sql =
            `UPDATE users SET ${fields.join(", ")}, updated_at=NOW()
             WHERE user_id=? AND company_id=? AND role IN ('admin','courier')`;
        params.push(id, companyId);

        const [result] = await pool.query(sql, params);
        if (result.affectedRows === 0)
            return res.status(404).json({ ok: false, error: "Не найдено" });

        const [rows] = await pool.query(
            "SELECT * FROM users WHERE user_id=? AND company_id=?",
            [id, companyId]
        );
        res.json({ ok: true, item: rows.length ? mapUnit(rows[0]) : null });
    } catch (e) {
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

        // удаляем только персонал (admin/courier), не owner/client
        const [result] = await pool.query(
            "DELETE FROM users WHERE user_id=? AND company_id=? AND role IN ('admin','courier')",
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
