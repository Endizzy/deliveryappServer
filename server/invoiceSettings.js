import pool from "./db.js";
import { resolveCompanyContext } from "./currentOrder.js";

// ─────────────────────────────────────────────────────────────────────────────
// Настройки накладной (реквизиты компании для печати заказа).
// Одна строка на компанию (PK company_id). Мультитенантность строго по company_id.
// Таблица invoice_settings создаётся вручную (см. SQL).
// ─────────────────────────────────────────────────────────────────────────────

// DB (snake_case) → фронт (camelCase)
function rowToDto(r) {
    return {
        companyName: r.company_name ?? "",
        regNumber: r.reg_number ?? "",
        email: r.email ?? "",
        website: r.website ?? "",
        footerMessage: r.footer_message ?? "",
    };
}

// GET /api/invoice-settings — настройки накладной текущей компании
export async function getInvoiceSettings(req, res) {
    try {
        const ctx = await resolveCompanyContext(req, res);
        if (!ctx) return;
        const { companyId } = ctx;

        const [rows] = await pool.query(
            `SELECT company_id, company_name, reg_number, email, website, footer_message
               FROM invoice_settings
              WHERE company_id = ?
              LIMIT 1`,
            [companyId]
        );

        // Нет строки → settings=null: клиент оставит свои значения по умолчанию
        res.json({ ok: true, settings: rows.length ? rowToDto(rows[0]) : null });
    } catch (e) {
        console.error("getInvoiceSettings error:", e);
        res.status(500).json({ ok: false, error: "Ошибка сервера" });
    }
}

// POST /api/invoice-settings — сохранить (upsert) настройки накладной компании
export async function saveInvoiceSettings(req, res) {
    try {
        const ctx = await resolveCompanyContext(req, res);
        if (!ctx) return;
        const { companyId } = ctx;

        const b = req.body || {};
        const companyName = (b.companyName ?? "").toString().slice(0, 150);
        const regNumber = (b.regNumber ?? "").toString().slice(0, 64);
        const email = (b.email ?? "").toString().slice(0, 255);
        const website = (b.website ?? "").toString().slice(0, 255);
        const footerMessage = (b.footerMessage ?? "").toString().slice(0, 500);

        await pool.query(
            `INSERT INTO invoice_settings
                (company_id, company_name, reg_number, email, website, footer_message)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                company_name   = VALUES(company_name),
                reg_number     = VALUES(reg_number),
                email          = VALUES(email),
                website        = VALUES(website),
                footer_message = VALUES(footer_message)`,
            [companyId, companyName, regNumber, email, website, footerMessage]
        );

        res.json({
            ok: true,
            settings: { companyName, regNumber, email, website, footerMessage },
        });
    } catch (e) {
        console.error("saveInvoiceSettings error:", e);
        res.status(500).json({ ok: false, error: "Ошибка сервера" });
    }
}
