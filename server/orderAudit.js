import pool from "./db.js";
import {
  buildAuditEvents,
  buildCreatedEvent,
  orderSnapshotFields,
  AUDIT_SOURCES,
} from "./orderAuditLogic.js";

// ─────────────────────────────────────────────────────────────────────────────
// Журнал изменений заказов (migrations/order_audit_log.sql): запись.
//
// Главный принцип: журнал НИКОГДА не должен влиять на работу с заказами.
//   • ни одна функция здесь не бросает исключений и не возвращает rejected-промис;
//   • запись вызывается уже ПОСЛЕ ответа клиенту, результат никто не ждёт;
//   • пока таблицы нет (SQL не выполнен), всё сводится к одной проверке
//     «таблица есть?» раз в минуту — заказы работают как раньше.
// Все записи привязаны к company_id заказа.
// ─────────────────────────────────────────────────────────────────────────────

// true кэшируем навсегда, false — на минуту (после SQL рестарт не нужен).
let _ready = null;
let _checkedAt = 0;

export async function orderAuditReady() {
  if (_ready === true) return true;
  if (_ready === false && Date.now() - _checkedAt < 60_000) return false;
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n
         FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_audit_log'`
    );
    _ready = Number(rows[0]?.n) === 1;
  } catch (e) {
    console.warn("[order-audit] проверка таблицы не удалась:", e?.message ?? e);
    _ready = false;
  }
  _checkedAt = Date.now();
  return _ready;
}

/**
 * Состояние заказа ДО правки (тот же запрос, что возвращает маршруты заказа:
 * с названиями курьера и ресторана). Ошибка или отсутствие таблицы → null.
 */
export async function auditSnapshot(companyId, orderId) {
  try {
    if (!(await orderAuditReady())) return null;
    const [rows] = await pool.query(
      `SELECT co.*,
              cu1.nickname AS courier_nickname,
              cu2.nickname AS pickup_nickname
         FROM current_orders co
              LEFT JOIN users cu1 ON cu1.user_id = co.courier_unit_id
              LEFT JOIN users cu2 ON cu2.user_id = co.pickup_unit_id
        WHERE co.company_id=? AND co.order_id=? LIMIT 1`,
      [companyId, orderId]
    );
    return rows[0] || null;
  } catch (e) {
    console.warn("[order-audit] snapshot не удался:", e?.message ?? e);
    return null;
  }
}

// Имя исполнителя: берём из users и помним 10 минут (не нагружаем БД)
const _names = new Map();
const NAME_TTL = 10 * 60_000;

async function actorName(companyId, userId) {
  if (userId == null) return "";
  const key = `${companyId}:${userId}`;
  const hit = _names.get(key);
  if (hit && Date.now() - hit.at < NAME_TTL) return hit.name;
  let name = "";
  try {
    const [rows] = await pool.query(
      "SELECT nickname, first_name, last_name, email FROM users WHERE user_id=? AND company_id=? LIMIT 1",
      [userId, companyId]
    );
    const r = rows[0] || {};
    const full = [r.first_name, r.last_name].filter(Boolean).join(" ");
    name = String(r.nickname || full || r.email || "").slice(0, 100);
  } catch {
    name = "";
  }
  if (_names.size > 500) _names.clear();
  _names.set(key, { name, at: Date.now() });
  return name;
}

/**
 * Записывает события журнала.
 *   before — снимок до правки (null для нового заказа), after — строка заказа
 *   после правки (как её вернул маршрут). companyId — компания ЗАКАЗА.
 * Возвращает Promise, который всегда выполняется успешно.
 */
export async function auditRecord({ req, companyId, orderId, before, after, source = "web" }) {
  try {
    const cid = Number(companyId);
    if (!Number.isInteger(cid) || cid <= 0 || !after) return;
    if (!(await orderAuditReady())) return;

    let events;
    if (before) {
      events = buildAuditEvents(before, after);
    } else {
      const c = buildCreatedEvent(after);
      events = c ? [c] : [];
    }
    if (!events.length) return;

    const src = AUDIT_SOURCES.includes(source) ? source : "web";
    const u = req?.user || {};
    const userId = u.userId ?? u.id ?? null;
    const name = src === "system" ? "" : await actorName(cid, userId);
    const snap = orderSnapshotFields(after);
    if (!snap.order_id) snap.order_id = Number(orderId) || 0;
    if (!snap.order_id) return;
    const now = new Date();

    const rows = events.map((e) => [
      cid, snap.order_id, snap.order_no, snap.order_seq, snap.order_seq_date,
      snap.customer_name, snap.customer_phone,
      e.event_type, e.old_value, e.new_value, e.amount_delta,
      e.important ? 1 : 0, e.flag,
      src === "system" ? null : userId, name,
      src === "system" ? null : (u.role ? String(u.role).slice(0, 20) : null),
      src, now,
    ]);

    await pool.query(
      `INSERT INTO order_audit_log
         (company_id, order_id, order_no, order_seq, order_seq_date,
          customer_name, customer_phone,
          event_type, old_value, new_value, amount_delta,
          important, flag,
          actor_user_id, actor_name, actor_role,
          source, created_at)
       VALUES ?`,
      [rows]
    );
  } catch (e) {
    console.warn("[order-audit] запись не удалась:", e?.code || "", e?.sqlMessage || e?.message || e);
  }
}
