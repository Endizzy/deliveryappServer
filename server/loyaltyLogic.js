// ─────────────────────────────────────────────────────────────────────────────
// Программа лояльности — чистая логика (без БД), чтобы её можно было тестировать.
//
// Правило: клиент делает N заказов без скидки, на (N+1)-м получает скидку,
// после чего счёт начинается заново.
// ─────────────────────────────────────────────────────────────────────────────

export const LOYALTY_MAX_ORDERS_BEFORE = 100;
export const LOYALTY_MAX_FIXED_EUR = 1000;

/** Приводит настройки из запроса к безопасному виду. Возвращает { ok, value|error }. */
export function sanitizeLoyaltySettings(input) {
    const b = input || {};
    const enabled = b.enabled === true || b.enabled === 1 || b.enabled === "1";

    const ordersBefore = Math.trunc(Number(b.ordersBefore));
    if (!Number.isFinite(ordersBefore) || ordersBefore < 1 || ordersBefore > LOYALTY_MAX_ORDERS_BEFORE) {
        return { ok: false, error: `Количество заказов до скидки: от 1 до ${LOYALTY_MAX_ORDERS_BEFORE}` };
    }

    const type = b.type === "percent" ? "percent" : "fixed";
    const raw = typeof b.value === "string" ? b.value.trim().replace(",", ".") : b.value;
    let value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        return { ok: false, error: "Размер скидки должен быть больше нуля" };
    }
    value = Math.round(value * 100) / 100;
    if (type === "percent" && value > 100) {
        return { ok: false, error: "Процент скидки: от 0,01 до 100" };
    }
    if (type === "fixed" && value > LOYALTY_MAX_FIXED_EUR) {
        return { ok: false, error: `Сумма скидки не более ${LOYALTY_MAX_FIXED_EUR} €` };
    }

    return { ok: true, value: { enabled, ordersBefore, type, value } };
}

/**
 * Где клиент в цикле.
 * completedInCycle — сколько его заказов (не отменённых) после последнего
 * заказа со скидкой лояльности (или после запуска программы).
 * Возвращает: position — номер ЭТОГО заказа в цикле (1-based),
 * willApply — положена ли на него скидка.
 */
export function evaluateProgress(completedInCycle, ordersBefore) {
    const cnt = Math.max(0, Math.trunc(Number(completedInCycle)) || 0);
    const n = Math.max(1, Math.trunc(Number(ordersBefore)) || 1);
    return { position: cnt + 1, willApply: cnt >= n, ordersBefore: n };
}

/**
 * Состояние клиента в программе (для списка владельца).
 * completedInCycle — сколько его заказов накоплено в текущем цикле.
 *  • ready — скидка уже положена (следующий заказ будет со скидкой);
 *  • soon  — до скидки осталось 1–2 заказа;
 *  • remaining — сколько заказов осталось до скидки (0, если ready).
 */
export const LOYALTY_SOON_THRESHOLD = 2;

export function classifyProgress(completedInCycle, ordersBefore) {
    const cnt = Math.max(0, Math.trunc(Number(completedInCycle)) || 0);
    const n = Math.max(1, Math.trunc(Number(ordersBefore)) || 1);
    const ready = cnt >= n;
    const remaining = ready ? 0 : n - cnt;
    return {
        ordersCount: cnt,
        ordersBefore: n,
        ready,
        remaining,
        soon: !ready && remaining <= LOYALTY_SOON_THRESHOLD,
    };
}

/**
 * Скидка лояльности в центах.
 * Формулы совпадают с постоянной скидкой клиента (см. normalizeItemsAndAmounts
 * и utils/money.js на клиенте):
 *  • fixed — вычитается из всей суммы позиций, но не больше неё;
 *  • percent — только от позиций без скидки в меню.
 */
export function loyaltyDiscountCents(loyalty, itemsTotalCents, percentBaseCents) {
    const v = Number(loyalty?.value);
    if (!loyalty || !Number.isFinite(v) || v <= 0) return 0;
    if (loyalty.type === "percent") {
        return Math.round((percentBaseCents * Math.min(v, 100)) / 100);
    }
    const cents = Math.round((v + Number.EPSILON) * 100);
    return Math.min(cents, itemsTotalCents);
}

/**
 * Итог по трём скидкам: применяется наибольшая, они не складываются.
 * Скидка лояльности «сгорает» только если победила именно она — при равенстве
 * побеждает прежняя скидка, чтобы клиент не терял бонус зря.
 */
export function pickOrderDiscount(personalCents, manualCents, loyaltyCents) {
    const other = Math.max(personalCents || 0, manualCents || 0);
    const loyalty = loyaltyCents || 0;
    return {
        orderDiscountCents: Math.max(other, loyalty),
        loyaltyWon: loyalty > other,
    };
}
