import pool from "./db.js";

// ─────────────────────────────────────────────────────────────────────────────
// Флаг блюда «Скидки запрещены» (menu.no_discount, migrations/menu_no_discount.sql).
//
// Блюдо с флагом всегда по полной цене: на него не действуют ни скидка блюда
// в меню, ни постоянная скидка клиента, ни разовая скидка. Исключение — скидка
// лояльности: она применяется как к обычной позиции.
//
// Пока колонки нет (SQL не выполнен), всё работает как раньше: флагов нет,
// запросы меню не трогают новую колонку. true кэшируем навсегда, false — на
// минуту, поэтому после выполнения SQL рестарт сервера не нужен.
// ─────────────────────────────────────────────────────────────────────────────

let _ready = null;
let _checkedAt = 0;

export async function noDiscountColumnReady() {
  if (_ready === true) return true;
  if (_ready === false && Date.now() - _checkedAt < 60_000) return false;
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu' AND COLUMN_NAME = 'no_discount'`
    );
    _ready = Number(rows[0]?.n) === 1;
  } catch (e) {
    console.warn("[menu] проверка колонки no_discount не удалась:", e?.message ?? e);
    _ready = false;
  }
  _checkedAt = Date.now();
  return _ready;
}

/** Фрагмент SELECT: колонка, если она есть, иначе константа 0 (SQL без пользовательских данных). */
export async function noDiscountSelect() {
  return (await noDiscountColumnReady()) ? "no_discount" : "0 AS no_discount";
}

/**
 * Проставляет флаг «скидки запрещены» позициям заказа по данным меню КОМПАНИИ.
 * Источник правды — база: флаг, присланный клиентом, игнорируется. Позиции с
 * флагом получают discount = 0 и noDiscount = true. Ошибка БД не должна
 * ломать заказ: тогда позиции возвращаются как есть.
 */
export async function withNoDiscountFlags(companyId, items) {
  if (!Array.isArray(items) || items.length === 0) return items;
  const strip = (it) => {
    if (it && typeof it === "object" && "noDiscount" in it) {
      const { noDiscount: _drop, ...rest } = it;
      return rest;
    }
    return it;
  };
  try {
    const cid = Number(companyId);
    if (!Number.isInteger(cid) || cid <= 0) return items.map(strip);
    if (!(await noDiscountColumnReady())) return items.map(strip);
    const ids = [...new Set(items.map((it) => Number(it?.id)).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return items.map(strip);
    const [rows] = await pool.query(
      "SELECT item_id FROM menu WHERE company_id = ? AND no_discount = 1 AND item_id IN (?)",
      [cid, ids]
    );
    const flagged = new Set(rows.map((r) => Number(r.item_id)));
    return items.map((it) =>
      flagged.has(Number(it?.id)) ? { ...strip(it), discount: 0, noDiscount: true } : strip(it)
    );
  } catch (e) {
    console.warn("[menu] флаги «скидки запрещены» не получены:", e?.message ?? e);
    return items.map(strip);
  }
}
