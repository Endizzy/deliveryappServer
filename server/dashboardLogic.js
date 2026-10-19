// ─────────────────────────────────────────────────────────────────────────────
// Dashboard владельца (вкладка «General Information») — чистая логика без БД,
// покрыта тестами (test/dashboard.test.js).
//
// «Сегодня» — операционный день в UTC, как у order_seq_date и вкладки
// «Завершённые» в панели заказов (см. deriveOrderSeqDate в currentOrder.js).
// ─────────────────────────────────────────────────────────────────────────────

/** Допустимые периоды в днях (включая сегодняшний). */
export const PERIOD_DAYS = { today: 1, "7": 7, "30": 30 };

/** Сколько дней показывать на графике: не меньше 14, при периоде 30 — 30. */
const MIN_CHART_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Date → "YYYY-MM-DD" (UTC). */
export function toDay(date) {
    return date.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" + n дней → "YYYY-MM-DD" (UTC). */
export function addDays(day, n) {
    return toDay(new Date(new Date(`${day}T00:00:00Z`).getTime() + n * DAY_MS));
}

/**
 * Границы периода и предыдущего периода для сравнения.
 *  today → сегодня и тот же день неделей раньше (понедельник с понедельником);
 *  7 / 30 → N дней и предыдущие N дней.
 * Неизвестное значение трактуем как "today": запрос не должен падать.
 */
export function resolvePeriod(raw, now = new Date()) {
    const key = Object.prototype.hasOwnProperty.call(PERIOD_DAYS, String(raw))
        ? String(raw)
        : "today";
    const days = PERIOD_DAYS[key];
    const today = toDay(now);

    const from = addDays(today, -(days - 1));
    let prevFrom;
    let prevTo;
    if (key === "today") {
        prevFrom = addDays(today, -7);
        prevTo = prevFrom;
    } else {
        prevTo = addDays(from, -1);
        prevFrom = addDays(prevTo, -(days - 1));
    }

    const chartDays = Math.max(MIN_CHART_DAYS, days);
    return {
        key,
        days,
        today,
        from,
        to: today,
        prevFrom,
        prevTo,
        chartDays,
        chartFrom: addDays(today, -(chartDays - 1)),
    };
}

/** Деньги: число с двумя знаками (DECIMAL приходит из mysql2 строкой). */
export function money(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Целое ≥ 0 из значения БД. */
export function count(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Изменение в процентах (целое). null, если сравнивать не с чем
 * (в прошлом периоде ноль): «рост на бесконечность» показывать нельзя.
 */
export function pctDelta(cur, prev) {
    const c = Number(cur);
    const p = Number(prev);
    if (!Number.isFinite(c) || !Number.isFinite(p) || p <= 0) return null;
    return Math.round(((c - p) / p) * 100);
}

/** Средний чек (0, если заказов нет). */
export function avgCheck(revenue, orders) {
    const o = Number(orders);
    return o > 0 ? money(Number(revenue) / o) : 0;
}

/**
 * Ряд по дням без пропусков: строки БД { d, sum } → [{ day, sum }] ровно
 * `days` элементов от `from`. Дни без заказов — 0 (иначе график «съедет»).
 * d может быть Date или строкой (зависит от драйвера).
 */
export function fillDaily(rows, from, days) {
    const bySum = new Map();
    for (const r of rows || []) {
        const key = r.d instanceof Date ? toDay(r.d) : String(r.d).slice(0, 10);
        bySum.set(key, (bySum.get(key) || 0) + money(r.sum));
    }
    const out = [];
    for (let i = 0; i < days; i += 1) {
        const day = addDays(from, i);
        out.push({ day, sum: money(bySum.get(day) || 0) });
    }
    return out;
}

/** Способы оплаты, которые знает система (порядок вывода). */
export const PAYMENT_ORDER = ["cash", "card", "wire", "paid"];

/**
 * Оплата: всегда все четыре способа (в том числе нулевые), с долей от суммы.
 * Неизвестные значения payment_method складываем в "other", чтобы сумма
 * сходилась с итогом.
 */
export function shapePayments(rows) {
    const acc = new Map();
    for (const r of rows || []) {
        const key = PAYMENT_ORDER.includes(r.payment_method) ? r.payment_method : "other";
        const cur = acc.get(key) || { orders: 0, sum: 0 };
        cur.orders += count(r.orders);
        cur.sum += money(r.sum);
        acc.set(key, cur);
    }
    const keys = acc.has("other") ? [...PAYMENT_ORDER, "other"] : PAYMENT_ORDER;
    const total = [...acc.values()].reduce((s, v) => s + v.sum, 0);
    return keys.map((method) => {
        const v = acc.get(method) || { orders: 0, sum: 0 };
        return {
            method,
            orders: v.orders,
            sum: money(v.sum),
            share: total > 0 ? Math.round((v.sum / total) * 100) : 0,
        };
    });
}

/**
 * Курьеры: строки БД → [{ id, name, orders, sum }], «не назначен» (id null)
 * всегда последним, остальные по числу заказов.
 */
export function shapeCouriers(rows, limit = 5) {
    const list = (rows || []).map((r) => ({
        id: r.courier_unit_id == null ? null : Number(r.courier_unit_id),
        name: String(r.name || "").trim(),
        orders: count(r.orders),
        sum: money(r.sum),
    }));
    const assigned = list
        .filter((c) => c.id != null)
        .sort((a, b) => b.orders - a.orders || b.sum - a.sum)
        .slice(0, limit);
    const none = list.find((c) => c.id == null);
    return none ? [...assigned, { ...none, name: "" }] : assigned;
}

/**
 * Скидка клиента из customer_discounts → { type, value } | null.
 */
export function shapeDiscount(row) {
    if (!row) return null;
    const value = Number(row.discount_value);
    if (!Number.isFinite(value) || value <= 0) return null;
    return { type: row.discount_type === "fixed" ? "fixed" : "percent", value };
}
