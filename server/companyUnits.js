import pool from "./db.js";
import bcrypt from "bcrypt";
const SALT_ROUNDS = 10;

const mapUnit = (r) => ({
    id: r.unit_id,
    companyId: r.company_id,
    nickname: r.unit_nickname,
    phone: r.unit_phone,
    email: r.unit_email,
    role: r.unit_role,
    active: !!r.is_active,
    lastEnter: r.unit_last_enter,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

// Грубая авторизация: любой, у кого есть companyId и не courier — может управлять
function ensureCanManage(req, res) {
    const u = req.user;
    if (!u || !u.companyId) {
        res.status(400).json({ ok: false, error: "У пользователя нет companyId" });
        return false;
    }
    if (String(u.role).toLowerCase() === "courier") {
        res.status(403).json({ ok: false, error: "Недостаточно прав" });
        return false;
    }
    return true;
}

export async function listUnits(req, res) {
    try {
        if (!ensureCanManage(req, res)) return;
        const { companyId } = req.user;
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
        if (!ensureCanManage(req, res)) return;
        const { companyId } = req.user;

        const {
            nickname,
            phone,
            email = null,
            role = "courier",
            password,
            active = true,
        } = req.body || {};

        if (!nickname || !phone || !password) {
            return res
                .status(400)
                .json({ ok: false, error: "nickname, phone и password обязательны" });
        }
        if (!["courier", "admin"].includes(String(role))) {
            return res.status(400).json({ ok: false, error: "Некорректная роль" });
        }

        const hash = await bcrypt.hash(String(password), SALT_ROUNDS);

        const [result] = await pool.query(
            `INSERT INTO company_units
       (company_id, unit_nickname, unit_phone, unit_email, unit_role, unit_password_hash, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [companyId, nickname, phone, email, role, hash, active ? 1 : 0]
        );

        const [rows] = await pool.query(
            "SELECT * FROM company_units WHERE unit_id = ? AND company_id = ?",
            [result.insertId, companyId]
        );
        res.status(201).json({ ok: true, item: mapUnit(rows[0]) });
    } catch (e) {
        // ловим уникальные ограничения
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
        if (!ensureCanManage(req, res)) return;
        const { companyId } = req.user;
        const id = Number(req.params.id);

        const {
            nickname,
            phone,
            email,
            role,
            active,
            password,
        } = req.body || {};

        const fields = [];
        const params = [];

        if (nickname !== undefined) {
            fields.push("unit_nickname = ?");
            params.push(nickname);
        }
        if (phone !== undefined) {
            fields.push("unit_phone = ?");
            params.push(phone);
        }
        if (email !== undefined) {
            fields.push("unit_email = ?");
            params.push(email || null);
        }
        if (role !== undefined) {
            if (!["courier", "admin"].includes(String(role)))
                return res.status(400).json({ ok: false, error: "Некорректная роль" });
            fields.push("unit_role = ?");
            params.push(role);
        }
        if (active !== undefined) {
            fields.push("is_active = ?");
            params.push(active ? 1 : 0);
        }
        if (password) {
            const hash = await bcrypt.hash(String(password), SALT_ROUNDS);
            fields.push("unit_password_hash = ?");
            params.push(hash);
        }

        if (!fields.length) {
            return res.json({ ok: true, item: null });
        }

        const sql = `UPDATE company_units SET ${fields.join(
            ", "
        )}, updated_at = CURRENT_TIMESTAMP WHERE unit_id = ? AND company_id = ?`;
        params.push(id, companyId);

        const [result] = await pool.query(sql, params);
        if (result.affectedRows === 0) {
            return res.status(404).json({ ok: false, error: "Не найдено" });
        }

        const [rows] = await pool.query(
            "SELECT * FROM company_units WHERE unit_id = ? AND company_id = ?",
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
        if (!ensureCanManage(req, res)) return;
        const { companyId } = req.user;
        const id = Number(req.params.id);

        const [result] = await pool.query(
            "DELETE FROM company_units WHERE unit_id = ? AND company_id = ?",
            [id, companyId]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ ok: false, error: "Не найдено" });
        }
        res.json({ ok: true });
    } catch (e) {
        console.error("deleteUnit error:", e);
        res.status(500).json({ ok: false, error: "Ошибка сервера" });
    }
}
