import { Router } from "express";
import pool from "./db.js";
import { resolveCompanyContext } from "./currentOrder.js";

// ─────────────────────────────────────────────────────────────────────────────
// Тикеты техподдержки (migrations/support_tickets.sql).
// Клиент пишет на сайте → уведомление в Telegram → ответ оператора reply.
// Пока таблиц нет — ready:false, сервер не падает.
// ─────────────────────────────────────────────────────────────────────────────

const TELEGRAM_BOT_URL = (process.env.TELEGRAM_BOT_URL || "http://localhost:3002").replace(
  /\/+$/,
  ""
);
const TELEGRAM_INTERNAL_API_KEY = process.env.TELEGRAM_INTERNAL_API_KEY || "";
const SUPPORT_INTERNAL_API_KEY =
  process.env.SUPPORT_INTERNAL_API_KEY || TELEGRAM_INTERNAL_API_KEY || "";

const ALLOWED_ROLES = new Set(["owner", "admin"]);
const MAX_SUBJECT = 200;
const MAX_BODY = 5000;

let _ready = null;
let _checkedAt = 0;

export async function supportTicketsReady() {
  if (_ready === true) return true;
  if (_ready === false && Date.now() - _checkedAt < 60_000) return false;
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n
         FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN ('support_tickets', 'support_ticket_messages')`
    );
    _ready = Number(rows[0]?.n) === 2;
  } catch (e) {
    console.warn("[support-tickets] проверка таблиц не удалась:", e?.message ?? e);
    _ready = false;
  }
  _checkedAt = Date.now();
  return _ready;
}

function canUseSupport(role) {
  return ALLOWED_ROLES.has(String(role || ""));
}

function toIso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function cleanText(raw, max) {
  const s = String(raw ?? "").trim().replace(/\r\n/g, "\n");
  if (!s) return "";
  return s.slice(0, max);
}

async function getUserPublic(userId) {
  if (!userId) return { email: null, name: "" };
  try {
    const [rows] = await pool.query(
      `SELECT email, nickname, first_name, last_name
         FROM users WHERE user_id=? LIMIT 1`,
      [userId]
    );
    const r = rows[0] || {};
    const full = [r.first_name, r.last_name].filter(Boolean).join(" ");
    return {
      email: r.email || null,
      name: String(r.nickname || full || r.email || "Пользователь").slice(0, 100),
    };
  } catch {
    return { email: null, name: "Пользователь" };
  }
}

async function getCompanyName(companyId) {
  try {
    const [rows] = await pool.query(
      "SELECT company_name FROM companies WHERE company_id=? LIMIT 1",
      [companyId]
    );
    return rows[0]?.company_name || null;
  } catch {
    return null;
  }
}

function ticketDto(row) {
  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    subject: row.subject,
    status: row.status,
    createdByUserId: row.created_by_user_id != null ? Number(row.created_by_user_id) : null,
    telegramMessageId:
      row.telegram_message_id != null ? Number(row.telegram_message_id) : null,
    lastMessageAt: toIso(row.last_message_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function messageDto(row) {
  return {
    id: Number(row.id),
    ticketId: Number(row.ticket_id),
    authorType: row.author_type,
    authorUserId: row.author_user_id != null ? Number(row.author_user_id) : null,
    authorName: row.author_name || "",
    body: row.body,
    createdAt: toIso(row.created_at),
  };
}

async function notifyTelegram(ticketPayload) {
  const headers = { "Content-Type": "application/json" };
  if (TELEGRAM_INTERNAL_API_KEY) headers["x-api-key"] = TELEGRAM_INTERNAL_API_KEY;

  const res = await fetch(`${TELEGRAM_BOT_URL}/api/tickets/notify`, {
    method: "POST",
    headers,
    body: JSON.stringify(ticketPayload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`telegram notify HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function loadTicketForCompany(ticketId, companyId) {
  const [rows] = await pool.query(
    `SELECT * FROM support_tickets WHERE id=? AND company_id=? LIMIT 1`,
    [ticketId, companyId]
  );
  return rows[0] || null;
}

export default function createSupportTicketsRouter() {
  const router = Router();

  router.use((req, res, next) => {
    if (!canUseSupport(req.user?.role)) {
      return res.status(403).json({ ok: false, error: "Доступ запрещён" });
    }
    next();
  });

  // GET /api/support-tickets
  router.get("/", async (req, res) => {
    try {
      const ctx = await resolveCompanyContext(req, res);
      if (!ctx) return;
      if (!(await supportTicketsReady())) {
        return res.json({ ok: true, ready: false, tickets: [] });
      }

      const status = String(req.query.status || "").trim();
      const params = [ctx.companyId];
      let where = "company_id=?";
      if (status && ["open", "answered", "closed"].includes(status)) {
        where += " AND status=?";
        params.push(status);
      }

      const [rows] = await pool.query(
        `SELECT * FROM support_tickets
          WHERE ${where}
          ORDER BY last_message_at DESC, id DESC
          LIMIT 200`,
        params
      );
      res.json({ ok: true, ready: true, tickets: rows.map(ticketDto) });
    } catch (e) {
      console.error("GET /support-tickets error:", e);
      res.status(500).json({ ok: false, error: "Не удалось загрузить тикеты" });
    }
  });

  // GET /api/support-tickets/:id
  router.get("/:id", async (req, res) => {
    try {
      const ctx = await resolveCompanyContext(req, res);
      if (!ctx) return;
      if (!(await supportTicketsReady())) {
        return res.status(409).json({ ok: false, ready: false, error: "Тикеты ещё не включены" });
      }

      const ticketId = Number(req.params.id);
      if (!Number.isFinite(ticketId) || ticketId <= 0) {
        return res.status(400).json({ ok: false, error: "Некорректный id" });
      }

      const ticket = await loadTicketForCompany(ticketId, ctx.companyId);
      if (!ticket) {
        return res.status(404).json({ ok: false, error: "Тикет не найден" });
      }

      const [messages] = await pool.query(
        `SELECT * FROM support_ticket_messages
          WHERE ticket_id=? AND company_id=?
          ORDER BY id ASC
          LIMIT 500`,
        [ticketId, ctx.companyId]
      );

      res.json({
        ok: true,
        ready: true,
        ticket: ticketDto(ticket),
        messages: messages.map(messageDto),
      });
    } catch (e) {
      console.error("GET /support-tickets/:id error:", e);
      res.status(500).json({ ok: false, error: "Не удалось загрузить тикет" });
    }
  });

  // POST /api/support-tickets  { subject, body }
  router.post("/", async (req, res) => {
    try {
      const ctx = await resolveCompanyContext(req, res);
      if (!ctx) return;
      if (!(await supportTicketsReady())) {
        return res.status(409).json({ ok: false, ready: false, error: "Тикеты ещё не включены" });
      }

      const subject = cleanText(req.body?.subject, MAX_SUBJECT);
      const body = cleanText(req.body?.body, MAX_BODY);
      if (!subject) {
        return res.status(400).json({ ok: false, error: "Укажите тему" });
      }
      if (!body) {
        return res.status(400).json({ ok: false, error: "Укажите описание" });
      }

      const userId = ctx.user?.userId ?? ctx.user?.id ?? null;
      const userInfo = await getUserPublic(userId);
      const companyName = await getCompanyName(ctx.companyId);

      const conn = await pool.getConnection();
      let ticketId;
      try {
        await conn.beginTransaction();
        const [ins] = await conn.query(
          `INSERT INTO support_tickets
             (company_id, created_by_user_id, subject, status, last_message_at)
           VALUES (?, ?, ?, 'open', NOW())`,
          [ctx.companyId, userId, subject]
        );
        ticketId = Number(ins.insertId);
        await conn.query(
          `INSERT INTO support_ticket_messages
             (ticket_id, company_id, author_type, author_user_id, author_name, body)
           VALUES (?, ?, 'user', ?, ?, ?)`,
          [ticketId, ctx.companyId, userId, userInfo.name, body]
        );
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }

      let telegramMessageId = null;
      try {
        const notify = await notifyTelegram({
          id: ticketId,
          subject,
          body,
          companyName,
          userEmail: userInfo.email,
          userName: userInfo.name,
        });
        telegramMessageId = notify?.telegramMessageId ?? null;
        if (telegramMessageId != null) {
          await pool.query(
            `UPDATE support_tickets SET telegram_message_id=? WHERE id=? AND company_id=?`,
            [telegramMessageId, ticketId, ctx.companyId]
          );
        }
      } catch (e) {
        console.warn("[support-tickets] Telegram notify failed:", e?.message ?? e);
      }

      const ticket = await loadTicketForCompany(ticketId, ctx.companyId);
      res.status(201).json({
        ok: true,
        ticket: ticketDto(ticket),
        telegramNotified: telegramMessageId != null,
      });
    } catch (e) {
      console.error("POST /support-tickets error:", e);
      res.status(500).json({ ok: false, error: "Не удалось создать тикет" });
    }
  });

  // POST /api/support-tickets/:id/messages  { body } — доп. сообщение клиента с сайта
  router.post("/:id/messages", async (req, res) => {
    try {
      const ctx = await resolveCompanyContext(req, res);
      if (!ctx) return;
      if (!(await supportTicketsReady())) {
        return res.status(409).json({ ok: false, ready: false, error: "Тикеты ещё не включены" });
      }

      const ticketId = Number(req.params.id);
      if (!Number.isFinite(ticketId) || ticketId <= 0) {
        return res.status(400).json({ ok: false, error: "Некорректный id" });
      }

      const body = cleanText(req.body?.body, MAX_BODY);
      if (!body) {
        return res.status(400).json({ ok: false, error: "Пустое сообщение" });
      }

      const ticket = await loadTicketForCompany(ticketId, ctx.companyId);
      if (!ticket) {
        return res.status(404).json({ ok: false, error: "Тикет не найден" });
      }
      if (ticket.status === "closed") {
        return res.status(409).json({ ok: false, error: "Тикет закрыт" });
      }

      const userId = ctx.user?.userId ?? ctx.user?.id ?? null;
      const userInfo = await getUserPublic(userId);
      const companyName = await getCompanyName(ctx.companyId);

      const [ins] = await pool.query(
        `INSERT INTO support_ticket_messages
           (ticket_id, company_id, author_type, author_user_id, author_name, body)
         VALUES (?, ?, 'user', ?, ?, ?)`,
        [ticketId, ctx.companyId, userId, userInfo.name, body]
      );
      await pool.query(
        `UPDATE support_tickets
            SET status='open', last_message_at=NOW()
          WHERE id=? AND company_id=?`,
        [ticketId, ctx.companyId]
      );

      try {
        await notifyTelegram({
          id: ticketId,
          subject: ticket.subject,
          body: `(дополнение)\n${body}`,
          companyName,
          userEmail: userInfo.email,
          userName: userInfo.name,
        });
      } catch (e) {
        console.warn("[support-tickets] Telegram notify (follow-up) failed:", e?.message ?? e);
      }

      const [rows] = await pool.query(
        `SELECT * FROM support_ticket_messages WHERE id=? LIMIT 1`,
        [ins.insertId]
      );
      res.status(201).json({ ok: true, message: messageDto(rows[0]) });
    } catch (e) {
      console.error("POST /support-tickets/:id/messages error:", e);
      res.status(500).json({ ok: false, error: "Не удалось отправить сообщение" });
    }
  });

  // POST /api/support-tickets/:id/close
  router.post("/:id/close", async (req, res) => {
    try {
      const ctx = await resolveCompanyContext(req, res);
      if (!ctx) return;
      if (!(await supportTicketsReady())) {
        return res.status(409).json({ ok: false, ready: false, error: "Тикеты ещё не включены" });
      }

      const ticketId = Number(req.params.id);
      if (!Number.isFinite(ticketId) || ticketId <= 0) {
        return res.status(400).json({ ok: false, error: "Некорректный id" });
      }

      const [result] = await pool.query(
        `UPDATE support_tickets SET status='closed'
          WHERE id=? AND company_id=?`,
        [ticketId, ctx.companyId]
      );
      if (!result.affectedRows) {
        return res.status(404).json({ ok: false, error: "Тикет не найден" });
      }

      const ticket = await loadTicketForCompany(ticketId, ctx.companyId);
      res.json({ ok: true, ticket: ticketDto(ticket) });
    } catch (e) {
      console.error("POST /support-tickets/:id/close error:", e);
      res.status(500).json({ ok: false, error: "Не удалось закрыть тикет" });
    }
  });

  return router;
}

/** Внутренний роут для telegram-support-bot (без JWT, по x-api-key). */
export function createSupportInternalRouter() {
  const router = Router();

  router.use((req, res, next) => {
    if (!SUPPORT_INTERNAL_API_KEY) {
      // Без ключа внутренний API закрыт — иначе любой в сети мог бы писать ответы.
      return res.status(503).json({ ok: false, error: "internal api key not configured" });
    }
    const key = req.header("x-api-key") || "";
    if (key !== SUPPORT_INTERNAL_API_KEY) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    next();
  });

  // POST /api/internal/support/reply  { ticketId, body }
  router.post("/reply", async (req, res) => {
    try {
      if (!(await supportTicketsReady())) {
        return res.status(409).json({ ok: false, ready: false, error: "tables missing" });
      }

      const ticketId = Number(req.body?.ticketId);
      const body = cleanText(req.body?.body, MAX_BODY);
      if (!Number.isFinite(ticketId) || ticketId <= 0) {
        return res.status(400).json({ ok: false, error: "ticketId required" });
      }
      if (!body) {
        return res.status(400).json({ ok: false, error: "body required" });
      }

      const [tickets] = await pool.query(
        `SELECT * FROM support_tickets WHERE id=? LIMIT 1`,
        [ticketId]
      );
      const ticket = tickets[0];
      if (!ticket) {
        return res.status(404).json({ ok: false, error: "ticket not found" });
      }
      if (ticket.status === "closed") {
        return res.status(409).json({ ok: false, error: "ticket closed" });
      }

      const [ins] = await pool.query(
        `INSERT INTO support_ticket_messages
           (ticket_id, company_id, author_type, author_user_id, author_name, body)
         VALUES (?, ?, 'support', NULL, 'Support', ?)`,
        [ticketId, ticket.company_id, body]
      );
      await pool.query(
        `UPDATE support_tickets
            SET status='answered', last_message_at=NOW()
          WHERE id=?`,
        [ticketId]
      );

      const [rows] = await pool.query(
        `SELECT * FROM support_ticket_messages WHERE id=? LIMIT 1`,
        [ins.insertId]
      );
      res.status(201).json({ ok: true, message: messageDto(rows[0]) });
    } catch (e) {
      console.error("POST /internal/support/reply error:", e);
      res.status(500).json({ ok: false, error: "failed to store reply" });
    }
  });

  return router;
}
