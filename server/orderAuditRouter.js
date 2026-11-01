import { Router } from "express";
import pool from "./db.js";
import { resolveCompanyContext } from "./currentOrder.js";
import { orderAuditReady } from "./orderAudit.js";
import { AUDIT_EVENT_TYPES, AUDIT_SOURCES } from "./orderAuditLogic.js";
import { parseAuditQuery } from "./orderAuditQuery.js";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/order-audit — журнал изменений заказов для владельца.
// Только чтение. ВСЕ запросы ограничены company_id пользователя.
// ─────────────────────────────────────────────────────────────────────────────

const toIso = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const toDay = (v) => {
  if (!v) return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

function rowToDto(r) {
  return {
    id: Number(r.id),
    createdAt: toIso(r.created_at),
    orderId: Number(r.order_id),
    orderNo: r.order_no ?? null,
    orderSeq: r.order_seq != null ? Number(r.order_seq) : null,
    orderDay: toDay(r.order_seq_date),
    customerName: r.customer_name ?? null,
    customerPhone: r.customer_phone ?? null,
    type: r.event_type,
    oldValue: r.old_value ?? null,
    newValue: r.new_value ?? null,
    amountDelta: r.amount_delta != null ? Number(r.amount_delta) : null,
    important: Number(r.important) === 1,
    flag: r.flag ?? null,
    actorId: r.actor_user_id != null ? Number(r.actor_user_id) : null,
    actorName: r.actor_name || "",
    actorRole: r.actor_role ?? null,
    source: r.source,
  };
}

export default function createOrderAuditRouter() {
  const router = Router();

  // Только владелец
  router.use((req, res, next) => {
    if (req.user?.role !== "owner") {
      return res.status(403).json({ ok: false, error: "Доступ запрещён" });
    }
    next();
  });

  // GET /api/order-audit?from=ISO&to=ISO&actor=ID&type=&source=&important=1&q=&page=1&pageSize=50[&export=1]
  router.get("/", async (req, res) => {
    try {
      const ctx = await resolveCompanyContext(req, res);
      if (!ctx) return;
      const { companyId } = ctx;

      if (!(await orderAuditReady())) {
        return res.json({
          ok: true, ready: false, items: [], total: 0,
          stats: { total: 0, amount: 0, courier: 0, afterDelivery: 0, important: 0 },
          actors: [],
        });
      }

      const f = parseAuditQuery(req.query, { types: AUDIT_EVENT_TYPES, sources: AUDIT_SOURCES });

      // Период и компания — общие для сводки и списка
      const baseWhere = ["company_id = ?", "created_at >= ?", "created_at < ?"];
      const baseParams = [companyId, f.from, f.to];

      // Фильтры списка
      const where = [...baseWhere];
      const params = [...baseParams];
      if (f.actor != null) { where.push("actor_user_id = ?"); params.push(f.actor); }
      if (f.type) { where.push("event_type = ?"); params.push(f.type); }
      if (f.source) { where.push("source = ?"); params.push(f.source); }
      if (f.important) where.push("important = 1");
      if (f.q) {
        const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const digits = f.q.replace(/\D/g, "");
        const parts = ["order_no LIKE ?", "customer_name LIKE ?"];
        params.push(like, like);
        if (digits) {
          parts.push("customer_phone LIKE ?");
          params.push(`%${digits}%`);
          parts.push("order_seq = ?");
          params.push(Number(digits));
        }
        where.push(`(${parts.join(" OR ")})`);
      }
      const whereSql = where.join(" AND ");

      const [[cnt]] = await pool.query(
        `SELECT COUNT(*) AS n FROM order_audit_log WHERE ${whereSql}`,
        params
      );
      const total = Number(cnt?.n) || 0;

      const limit = f.exportAll ? 5000 : f.pageSize;
      const offset = f.exportAll ? 0 : (f.page - 1) * f.pageSize;
      const [rows] = await pool.query(
        `SELECT * FROM order_audit_log
          WHERE ${whereSql}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      let stats = { total: 0, amount: 0, courier: 0, afterDelivery: 0, important: 0 };
      let actors = [];
      if (!f.exportAll) {
        const [[s]] = await pool.query(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(event_type = 'amount'), 0) AS amount,
                  COALESCE(SUM(event_type = 'courier'), 0) AS courier,
                  COALESCE(SUM(flag = 'after_delivery'), 0) AS after_delivery,
                  COALESCE(SUM(important = 1), 0) AS important
             FROM order_audit_log
            WHERE ${baseWhere.join(" AND ")}`,
          baseParams
        );
        stats = {
          total: Number(s?.total) || 0,
          amount: Number(s?.amount) || 0,
          courier: Number(s?.courier) || 0,
          afterDelivery: Number(s?.after_delivery) || 0,
          important: Number(s?.important) || 0,
        };
        const [a] = await pool.query(
          `SELECT actor_user_id, MAX(actor_name) AS actor_name
             FROM order_audit_log
            WHERE ${baseWhere.join(" AND ")} AND actor_user_id IS NOT NULL
            GROUP BY actor_user_id
            ORDER BY actor_name ASC
            LIMIT 100`,
          baseParams
        );
        actors = a.map((r) => ({ id: Number(r.actor_user_id), name: r.actor_name || `#${r.actor_user_id}` }));
      }

      res.json({
        ok: true,
        ready: true,
        page: f.page,
        pageSize: f.pageSize,
        total,
        items: rows.map(rowToDto),
        stats,
        actors,
      });
    } catch (e) {
      console.error("GET /order-audit error:", e);
      res.status(500).json({ ok: false, error: "Не удалось загрузить журнал" });
    }
  });

  return router;
}
