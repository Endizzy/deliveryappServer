import { Router } from "express";
import pool from "./db.js";
import { resolveCompanyContext } from "./currentOrder.js";
import { normalizePhone } from "./customers.js";
import { sanitizeLoyaltySettings, evaluateProgress } from "./loyaltyLogic.js";

// ─────────────────────────────────────────────────────────────────────────────
// Программа лояльности: скидка на (N+1)-й заказ клиента.
// Настройки — таблица loyalty_settings (одна строка на компанию), отметка о
// выданной скидке — колонки loyalty_* в current_orders.
// Таблицы/колонки создаются вручную: migrations/loyalty.sql.
//
// Главный принцип: лояльность НИКОГДА не должна ломать оформление заказа.
// Любая ошибка здесь логируется и означает «скидки нет».
// ─────────────────────────────────────────────────────────────────────────────

// ── Проверка, что миграция выполнена ─────────────────────────────────────────
// true кэшируем навсегда, false — на минуту (чтобы после выполнения миграции
// не требовался рестарт, но и не дёргать INFORMATION_SCHEMA на каждый заказ).
let _ready = null;
let _readyCheckedAt = 0;

export async function loyaltyColumnsReady() {
    if (_ready === true) return true;
    if (_ready === false && Date.now() - _readyCheckedAt < 60_000) return false;
    try {
        const [rows] = await pool.query(
            `SELECT COUNT(*) AS n
               FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'current_orders'
                AND COLUMN_NAME IN ('loyalty_applied','loyalty_type','loyalty_value','loyalty_order_no')`
        );
        const [tbl] = await pool.query(
            `SELECT COUNT(*) AS n
               FROM INFORMATION_SCHEMA.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loyalty_settings'`
        );
        _ready = Number(rows[0]?.n) === 4 && Number(tbl[0]?.n) === 1;
    } catch (e) {
        console.warn("[loyalty] проверка миграции не удалась:", e?.message ?? e);
        _ready = false;
    }
    _readyCheckedAt = Date.now();
    if (!_ready) console.warn("[loyalty] миграция loyalty.sql не выполнена — скидка лояльности отключена");
    return _ready;
}

function rowToSettings(r) {
    return {
        enabled: Number(r.enabled) === 1,
        ordersBefore: Number(r.orders_before) || 10,
        type: r.discount_type === "percent" ? "percent" : "fixed",
        value: Number(r.discount_value) || 0,
        activeSince: r.active_since ?? null,
    };
}

const DEFAULT_SETTINGS = {
    enabled: false,
    ordersBefore: 10,
    type: "fixed",
    value: 0,
    activeSince: null,
};

/** Настройки компании (или значения по умолчанию). Не бросает исключений. */
export async function getLoyaltySettings(companyId) {
    try {
        if (!(await loyaltyColumnsReady())) return { ...DEFAULT_SETTINGS };
        const [rows] = await pool.query(
            `SELECT enabled, orders_before, discount_type, discount_value, active_since
               FROM loyalty_settings WHERE company_id = ? LIMIT 1`,
            [companyId]
        );
        return rows.length ? rowToSettings(rows[0]) : { ...DEFAULT_SETTINGS };
    } catch (e) {
        console.warn("[loyalty] getLoyaltySettings:", e?.message ?? e);
        return { ...DEFAULT_SETTINGS };
    }
}

/**
 * Положена ли клиенту скидка лояльности на НОВЫЙ заказ.
 * Возвращает null, если программа выключена / телефон пустой / ошибка.
 * Иначе: { position, willApply, ordersBefore, type, value }.
 *
 * Считаем заказы клиента (не отменённые), созданные после запуска программы и
 * после последнего заказа со скидкой лояльности. Отмена заказа со скидкой
 * автоматически возвращает скидку — счётчика, который нужно чинить, нет.
 */
export async function getLoyaltyOffer(companyId, phoneRaw) {
    try {
        const phone = normalizePhone(phoneRaw);
        if (!phone) return null;

        const settings = await getLoyaltySettings(companyId);
        if (!settings.enabled || !(settings.value > 0)) return null;

        const [rows] = await pool.query(
            `SELECT COUNT(*) AS cnt
               FROM current_orders o
              WHERE o.company_id = ?
                AND o.customer_phone = ?
                AND o.status <> 'cancelled'
                AND o.created_at >= (
                      SELECT COALESCE(active_since, '1970-01-01 00:00:00')
                        FROM loyalty_settings WHERE company_id = ?)
                AND o.order_id > COALESCE((
                      SELECT MAX(x.order_id)
                        FROM current_orders x
                       WHERE x.company_id = ?
                         AND x.customer_phone = ?
                         AND x.loyalty_applied = 1
                         AND x.status <> 'cancelled'), 0)`,
            [companyId, phone, companyId, companyId, phone]
        );

        const { position, willApply, ordersBefore } = evaluateProgress(
            rows[0]?.cnt,
            settings.ordersBefore
        );
        return {
            position,
            willApply,
            ordersBefore,
            type: settings.type,
            value: settings.value,
        };
    } catch (e) {
        console.warn("[loyalty] getLoyaltyOffer:", e?.message ?? e);
        return null;
    }
}

export default function createLoyaltyRouter() {
    const router = Router();

    // GET /api/loyalty/settings
    router.get("/settings", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const ready = await loyaltyColumnsReady();
            const settings = await getLoyaltySettings(ctx.companyId);
            res.json({ ok: true, ready, settings });
        } catch (e) {
            console.error("loyalty settings get error:", e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    // PUT /api/loyalty/settings
    // body: { enabled, ordersBefore, type: 'fixed'|'percent', value }
    router.put("/settings", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;

            if (!(await loyaltyColumnsReady())) {
                return res.status(409).json({
                    ok: false,
                    error: "Не выполнена SQL-миграция loyalty.sql — сохранить настройки нельзя",
                });
            }

            const parsed = sanitizeLoyaltySettings(req.body);
            if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
            const s = parsed.value;

            // active_since выставляется при первом включении и при повторном
            // включении после паузы: счёт заказов идёт с этого момента.
            // ВАЖНО: в ON DUPLICATE KEY UPDATE присваивания выполняются слева
            // направо, поэтому active_since стоит ДО enabled — иначе условие
            // enabled=0 увидело бы уже новое значение.
            await pool.query(
                `INSERT INTO loyalty_settings
                    (company_id, enabled, orders_before, discount_type, discount_value, active_since)
                 VALUES (?, ?, ?, ?, ?, IF(? = 1, NOW(), NULL))
                 ON DUPLICATE KEY UPDATE
                    orders_before  = VALUES(orders_before),
                    discount_type  = VALUES(discount_type),
                    discount_value = VALUES(discount_value),
                    active_since   = IF(VALUES(enabled) = 1 AND (enabled = 0 OR active_since IS NULL),
                                        NOW(), active_since),
                    enabled        = VALUES(enabled)`,
                [companyId, s.enabled ? 1 : 0, s.ordersBefore, s.type, s.value, s.enabled ? 1 : 0]
            );

            const settings = await getLoyaltySettings(companyId);
            res.json({ ok: true, settings });
        } catch (e) {
            console.error("loyalty settings save error:", e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    // GET /api/loyalty/status?phone=  — для формы заказа (предпросмотр)
    // Итоговые суммы всё равно считает сервер при создании заказа.
    router.get("/status", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const offer = await getLoyaltyOffer(ctx.companyId, req.query.phone);
            if (!offer) return res.json({ ok: true, enabled: false });
            res.json({ ok: true, enabled: true, ...offer });
        } catch (e) {
            // Форма заказа не должна ломаться из-за лояльности
            console.error("loyalty status error:", e);
            res.json({ ok: true, enabled: false });
        }
    });

    return router;
}
