import { Router } from "express";
import pool from "./db.js";
import { resolveCompanyContext } from "./currentOrder.js";
import { normalizePhone } from "./customers.js";
import {
    canUseNotes,
    canManageNote,
    isValidNotePhone,
    validateNoteText,
    rowToNoteDto,
} from "./customerNotesLogic.js";

// ─────────────────────────────────────────────────────────────────────────────
// Заметки администраторов о клиентах (migrations/customer_admin_notes.sql).
// Привязаны к company_id + телефон клиента; видны только owner/admin компании.
// В накладную, панель заказов и мобильное приложение НЕ попадают.
//
// Принцип: заметки никогда не должны ломать оформление заказа. Пока таблицы
// нет — GET отвечает ready:false, остальные запросы — 409.
// ─────────────────────────────────────────────────────────────────────────────

// true кэшируем навсегда, false — на минуту (после миграции рестарт не нужен).
let _ready = null;
let _checkedAt = 0;

export async function customerNotesReady() {
    if (_ready === true) return true;
    if (_ready === false && Date.now() - _checkedAt < 60_000) return false;
    try {
        const [rows] = await pool.query(
            `SELECT COUNT(*) AS n
               FROM INFORMATION_SCHEMA.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customer_admin_notes'`
        );
        _ready = Number(rows[0]?.n) === 1;
    } catch (e) {
        console.warn("[customer-notes] проверка таблицы не удалась:", e?.message ?? e);
        _ready = false;
    }
    _checkedAt = Date.now();
    return _ready;
}

// Имя автора: nickname (название ресторана/логин) → имя → запасной вариант.
async function getAuthorName(userId) {
    try {
        const [rows] = await pool.query(
            "SELECT nickname, first_name, last_name FROM users WHERE user_id=? LIMIT 1",
            [userId]
        );
        const r = rows[0] || {};
        const full = [r.first_name, r.last_name].filter(Boolean).join(" ");
        return String(r.nickname || full || "Администратор").slice(0, 100);
    } catch {
        return "Администратор";
    }
}

export default function createCustomerNotesRouter() {
    const router = Router();

    // Только owner/admin
    router.use((req, res, next) => {
        if (!canUseNotes(req.user?.role)) {
            return res.status(403).json({ ok: false, error: "Доступ запрещён" });
        }
        next();
    });

    // GET /api/customer-notes?phone=+371…
    router.get("/", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            if (!(await customerNotesReady())) {
                return res.json({ ok: true, ready: false, notes: [] });
            }
            const phone = normalizePhone(req.query.phone);
            if (!isValidNotePhone(phone)) {
                return res.json({ ok: true, ready: true, notes: [] });
            }
            const [rows] = await pool.query(
                `SELECT * FROM customer_admin_notes
                  WHERE company_id=? AND customer_phone=?
                  ORDER BY (done_at IS NOT NULL) ASC, id DESC
                  LIMIT 200`,
                [ctx.companyId, phone]
            );
            res.json({ ok: true, ready: true, notes: rows.map((r) => rowToNoteDto(r, req.user)) });
        } catch (e) {
            console.error("GET /customer-notes error:", e);
            res.status(500).json({ ok: false, error: "Не удалось загрузить заметки" });
        }
    });

    // POST /api/customer-notes   body: { phone, text }
    router.post("/", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            if (!(await customerNotesReady())) {
                return res.status(409).json({ ok: false, error: "Не выполнена SQL-миграция customer_admin_notes.sql" });
            }
            const phone = normalizePhone(req.body?.phone);
            if (!isValidNotePhone(phone)) {
                return res.status(400).json({ ok: false, error: "Некорректный телефон клиента" });
            }
            const v = validateNoteText(req.body?.text);
            if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

            const userId = req.user?.userId ?? req.user?.id ?? null;
            const authorName = await getAuthorName(userId);
            const [ins] = await pool.query(
                `INSERT INTO customer_admin_notes
                    (company_id, customer_phone, note_text, created_by, created_by_name)
                 VALUES (?, ?, ?, ?, ?)`,
                [ctx.companyId, phone, v.text, userId, authorName]
            );
            const [rows] = await pool.query(
                "SELECT * FROM customer_admin_notes WHERE id=? AND company_id=?",
                [ins.insertId, ctx.companyId]
            );
            res.json({ ok: true, note: rowToNoteDto(rows[0], req.user) });
        } catch (e) {
            console.error("POST /customer-notes error:", e);
            res.status(500).json({ ok: false, error: "Не удалось сохранить заметку" });
        }
    });

    // PUT /api/customer-notes/:id   body: { text? , done? }
    router.put("/:id", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            if (!(await customerNotesReady())) {
                return res.status(409).json({ ok: false, error: "Не выполнена SQL-миграция customer_admin_notes.sql" });
            }
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) {
                return res.status(400).json({ ok: false, error: "Некорректный id" });
            }
            const [found] = await pool.query(
                "SELECT * FROM customer_admin_notes WHERE id=? AND company_id=? LIMIT 1",
                [id, ctx.companyId]
            );
            if (!found.length) return res.status(404).json({ ok: false, error: "Заметка не найдена" });
            const note = found[0];

            const hasText = req.body?.text !== undefined;
            const hasDone = req.body?.done !== undefined;
            if (!hasText && !hasDone) {
                return res.status(400).json({ ok: false, error: "Нечего менять" });
            }

            const sets = [];
            const params = [];
            if (hasText) {
                if (!canManageNote(req.user, note)) {
                    return res.status(403).json({ ok: false, error: "Менять текст может автор или владелец" });
                }
                const v = validateNoteText(req.body.text);
                if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
                sets.push("note_text=?");
                params.push(v.text);
            }
            if (hasDone) {
                // «Выполнено» может отметить любой администратор компании
                if (req.body.done) {
                    if (!note.done_at) {
                        const userId = req.user?.userId ?? req.user?.id ?? null;
                        const name = await getAuthorName(userId);
                        sets.push("done_at=NOW()", "done_by=?", "done_by_name=?");
                        params.push(userId, name);
                    }
                } else {
                    sets.push("done_at=NULL", "done_by=NULL", "done_by_name=NULL");
                }
            }
            if (sets.length) {
                await pool.query(
                    `UPDATE customer_admin_notes SET ${sets.join(", ")} WHERE id=? AND company_id=?`,
                    [...params, id, ctx.companyId]
                );
            }
            const [rows] = await pool.query(
                "SELECT * FROM customer_admin_notes WHERE id=? AND company_id=?",
                [id, ctx.companyId]
            );
            res.json({ ok: true, note: rowToNoteDto(rows[0], req.user) });
        } catch (e) {
            console.error("PUT /customer-notes/:id error:", e);
            res.status(500).json({ ok: false, error: "Не удалось обновить заметку" });
        }
    });

    // DELETE /api/customer-notes/:id — автор или владелец
    router.delete("/:id", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            if (!(await customerNotesReady())) {
                return res.status(409).json({ ok: false, error: "Не выполнена SQL-миграция customer_admin_notes.sql" });
            }
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) {
                return res.status(400).json({ ok: false, error: "Некорректный id" });
            }
            const [found] = await pool.query(
                "SELECT * FROM customer_admin_notes WHERE id=? AND company_id=? LIMIT 1",
                [id, ctx.companyId]
            );
            if (!found.length) return res.status(404).json({ ok: false, error: "Заметка не найдена" });
            if (!canManageNote(req.user, found[0])) {
                return res.status(403).json({ ok: false, error: "Удалить может автор или владелец" });
            }
            await pool.query("DELETE FROM customer_admin_notes WHERE id=? AND company_id=?", [id, ctx.companyId]);
            res.json({ ok: true });
        } catch (e) {
            console.error("DELETE /customer-notes/:id error:", e);
            res.status(500).json({ ok: false, error: "Не удалось удалить заметку" });
        }
    });

    return router;
}
