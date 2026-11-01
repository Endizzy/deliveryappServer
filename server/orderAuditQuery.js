// Разбор параметров запроса журнала изменений (чистая функция, покрыта тестами).
// Любые некорректные значения заменяются безопасными по умолчанию.

const DAY = 24 * 60 * 60 * 1000;
export const AUDIT_MAX_RANGE_DAYS = 366;
export const AUDIT_DEFAULT_RANGE_DAYS = 7;

const toDate = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

const toPosInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export function parseAuditQuery(query = {}, { types = [], sources = [] } = {}, now = new Date()) {
  let to = toDate(query.to);
  let from = toDate(query.from);

  if (!to) to = new Date(now.getTime() + 60_000);
  if (!from) from = new Date(to.getTime() - AUDIT_DEFAULT_RANGE_DAYS * DAY);
  if (from.getTime() >= to.getTime()) from = new Date(to.getTime() - AUDIT_DEFAULT_RANGE_DAYS * DAY);
  if (to.getTime() - from.getTime() > AUDIT_MAX_RANGE_DAYS * DAY) {
    from = new Date(to.getTime() - AUDIT_MAX_RANGE_DAYS * DAY);
  }

  const type = types.includes(String(query.type)) ? String(query.type) : null;
  const source = sources.includes(String(query.source)) ? String(query.source) : null;

  const q = String(query.q ?? "").replace(/\s+/g, " ").trim().slice(0, 64);

  let pageSize = Number(query.pageSize);
  pageSize = Number.isInteger(pageSize) ? Math.min(100, Math.max(10, pageSize)) : 50;

  return {
    from,
    to,
    actor: toPosInt(query.actor),
    type,
    source,
    important: query.important === "1" || query.important === "true",
    q,
    page: Math.min(100000, toPosInt(query.page) ?? 1),
    pageSize,
    exportAll: query.export === "1" || query.export === "true",
  };
}
