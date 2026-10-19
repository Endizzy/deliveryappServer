import { Router } from "express";
import pool from "./db.js";
import { resolveCompanyContext } from "./currentOrder.js";
import {
    resolvePeriod,
    addDays,
    money,
    count,
    pctDelta,
    avgCheck,
    fillDaily,
    shapePayments,
    shapeCouriers,
    shapeDiscount,
} from "./dashboardLogic.js";

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard владельца (вкладка «General Information» в настройках).
//
// ТОЛЬКО ЧТЕНИЕ: ничего не создаёт и не меняет (никаких CREATE/ALTER/INSERT),
// поэтому не может повлиять на работу смены. Данные считаются из current_orders
// теми же правилами, что вкладки «Анализ» и «Клиенты»: отменённые заказы в
// выручку и в число заказов не входят.
//
// Каждая секция считается независимо: если запрос одной секции упал, в ответе
// она null, имя попадает в `failed`, остальные секции работают как обычно.
// ─────────────────────────────────────────────────────────────────────────────

/** Окно «лучших клиентов» — всегда 30 дней, не зависит от выбранного периода. */
const TOP_CUSTOMERS_DAYS = 30;
const TOP_CUSTOMERS_LIMIT = 5;

/** Незавершённые заказы старше этого окна (в днях) считаем забытыми. */
const LIVE_WINDOW_DAYS = 30;

export default function createDashboardRouter() {
    const router = Router();

    // Выручка и клиенты — только для владельца (как и страница настроек)
    router.use((req, res, next) => {
        if (req.user?.role !== "owner") {
            return res.status(403).json({ ok: false, error: "Доступ запрещён" });
        }
        next();
    });

    // GET /api/dashboard/summary?period=today|7|30
    router.get("/summary", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;

            const p = resolvePeriod(req.query.period);
            const failed = [];
            const safe = async (name, fn) => {
                try {
                    return await fn();
                } catch (e) {
                    console.error(`[dashboard] ${name} failed:`, e?.sqlMessage || e?.message || e);
                    failed.push(name);
                    return null;
                }
            };

            // Общий отбор: заказы компании за диапазон операционных дней, без отменённых
            const NOT_CANCELLED = "company_id = ? AND status <> 'cancelled' AND order_seq_date BETWEEN ? AND ?";

            const [kpi, chart, payments, couriers, topCustomers, personalDiscounts] =
                await Promise.all([
                    // ── Показатели периода + сравнение с предыдущим ──────────
                    safe("kpi", async () => {
                        const [[cur]] = await pool.query(
                            `SELECT COUNT(*)                                   AS orders,
                                    COALESCE(SUM(amount_total), 0)             AS revenue,
                                    COALESCE(SUM(amount_discount), 0)          AS discount_sum,
                                    COALESCE(SUM(amount_discount > 0), 0)      AS discount_orders,
                                    COALESCE(SUM(manual_discount_percent > 0), 0) AS manual_orders
                               FROM current_orders
                              WHERE ${NOT_CANCELLED}`,
                            [companyId, p.from, p.to]
                        );
                        const [[prev]] = await pool.query(
                            `SELECT COUNT(*)                       AS orders,
                                    COALESCE(SUM(amount_total), 0) AS revenue
                               FROM current_orders
                              WHERE ${NOT_CANCELLED}`,
                            [companyId, p.prevFrom, p.prevTo]
                        );
                        const [[cancelled]] = await pool.query(
                            `SELECT COUNT(*) AS n
                               FROM current_orders
                              WHERE company_id = ? AND status = 'cancelled'
                                AND order_seq_date BETWEEN ? AND ?`,
                            [companyId, p.from, p.to]
                        );
                        // «Прямо сейчас»: не зависит от периода. Нижняя граница по
                        // дате — чтобы не сканировать всю историю; верхней нет,
                        // у предзаказов день заказа может быть в будущем.
                        const [[live]] = await pool.query(
                            `SELECT COALESCE(SUM(order_type = 'active'
                                     AND status IN ('new','preparing','ready','enroute')), 0) AS in_work,
                                    COALESCE(SUM(order_type = 'preorder'), 0)                  AS preorders
                               FROM current_orders
                              WHERE company_id = ?
                                AND status NOT IN ('completed','cancelled')
                                AND order_seq_date >= ?`,
                            [companyId, addDays(p.today, -LIVE_WINDOW_DAYS)]
                        );

                        const orders = count(cur.orders);
                        const revenue = money(cur.revenue);
                        const prevOrders = count(prev.orders);
                        const prevRevenue = money(prev.revenue);
                        const avg = avgCheck(revenue, orders);
                        const prevAvg = avgCheck(prevRevenue, prevOrders);
                        return {
                            revenue,
                            orders,
                            avgCheck: avg,
                            prevRevenue,
                            prevOrders,
                            prevAvgCheck: prevAvg,
                            revenueDelta: pctDelta(revenue, prevRevenue),
                            ordersDelta: pctDelta(orders, prevOrders),
                            avgCheckDelta: pctDelta(avg, prevAvg),
                            discountSum: money(cur.discount_sum),
                            discountOrders: count(cur.discount_orders),
                            manualOrders: count(cur.manual_orders),
                            cancelled: count(cancelled.n),
                            inWork: count(live.in_work),
                            preorders: count(live.preorders),
                        };
                    }),

                    // ── Выручка по дням (график) ─────────────────────────────
                    safe("chart", async () => {
                        const [rows] = await pool.query(
                            `SELECT DATE_FORMAT(order_seq_date, '%Y-%m-%d') AS d, COALESCE(SUM(amount_total), 0) AS sum
                               FROM current_orders
                              WHERE ${NOT_CANCELLED}
                              GROUP BY order_seq_date`,
                            [companyId, p.chartFrom, p.today]
                        );
                        const days = fillDaily(rows, p.chartFrom, p.chartDays);
                        return {
                            days,
                            total: money(days.reduce((s, d) => s + d.sum, 0)),
                        };
                    }),

                    // ── Способы оплаты ───────────────────────────────────────
                    safe("payments", async () => {
                        const [rows] = await pool.query(
                            `SELECT payment_method,
                                    COUNT(*)                       AS orders,
                                    COALESCE(SUM(amount_total), 0) AS sum
                               FROM current_orders
                              WHERE ${NOT_CANCELLED}
                              GROUP BY payment_method`,
                            [companyId, p.from, p.to]
                        );
                        return shapePayments(rows);
                    }),

                    // ── Курьеры ──────────────────────────────────────────────
                    safe("couriers", async () => {
                        const [rows] = await pool.query(
                            `SELECT co.courier_unit_id,
                                    COUNT(*)                          AS orders,
                                    COALESCE(SUM(co.amount_total), 0) AS sum,
                                    MAX(COALESCE(
                                        NULLIF(TRIM(u.nickname), ''),
                                        NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
                                        u.email
                                    ))                                AS name
                               FROM current_orders co
                               LEFT JOIN users u
                                      ON u.user_id = co.courier_unit_id
                                     AND u.company_id = co.company_id
                              WHERE co.company_id = ? AND co.status <> 'cancelled'
                                AND co.order_seq_date BETWEEN ? AND ?
                              GROUP BY co.courier_unit_id`,
                            [companyId, p.from, p.to]
                        );
                        return shapeCouriers(rows);
                    }),

                    // ── Лучшие клиенты за 30 дней ────────────────────────────
                    safe("topCustomers", async () => {
                        const from = addDays(p.today, -(TOP_CUSTOMERS_DAYS - 1));
                        const [rows] = await pool.query(
                            `SELECT customer_phone AS phone,
                                    COUNT(*)                       AS orders,
                                    COALESCE(SUM(amount_total), 0) AS sum
                               FROM current_orders
                              WHERE ${NOT_CANCELLED}
                                AND customer_phone IS NOT NULL AND customer_phone <> ''
                              GROUP BY customer_phone
                              ORDER BY sum DESC, orders DESC
                              LIMIT ${TOP_CUSTOMERS_LIMIT}`,
                            [companyId, from, p.today]
                        );
                        if (!rows.length) return [];

                        const phones = rows.map((r) => r.phone);

                        // Имя — из самого свежего заказа клиента
                        const [nameRows] = await pool.query(
                            `SELECT customer_phone AS phone, customer_name AS name
                               FROM current_orders
                              WHERE company_id = ? AND customer_phone IN (?)
                              ORDER BY created_at DESC, order_id DESC`,
                            [companyId, phones]
                        );
                        const names = new Map();
                        for (const r of nameRows) {
                            if (!names.has(r.phone)) names.set(r.phone, String(r.name || "").trim());
                        }

                        // Персональная скидка. Таблицы может не быть — тогда без скидок,
                        // сам список клиентов от этого не страдает.
                        const discounts = new Map();
                        try {
                            const [dRows] = await pool.query(
                                `SELECT customer_phone AS phone, discount_type, discount_value
                                   FROM customer_discounts
                                  WHERE company_id = ? AND customer_phone IN (?)`,
                                [companyId, phones]
                            );
                            for (const d of dRows) discounts.set(d.phone, shapeDiscount(d));
                        } catch (e) {
                            console.warn("[dashboard] customer_discounts недоступна:", e?.message || e);
                        }

                        return rows.map((r) => ({
                            name: names.get(r.phone) || "",
                            orders: count(r.orders),
                            sum: money(r.sum),
                            discount: discounts.get(r.phone) || null,
                        }));
                    }),

                    // ── Сколько клиентов с персональной скидкой ──────────────
                    safe("personalDiscounts", async () => {
                        const [[row]] = await pool.query(
                            `SELECT COUNT(*) AS n
                               FROM customer_discounts
                              WHERE company_id = ? AND discount_value > 0`,
                            [companyId]
                        );
                        return count(row.n);
                    }),
                ]);

            res.set("Cache-Control", "no-store");
            res.json({
                ok: true,
                period: {
                    key: p.key,
                    today: p.today,
                    from: p.from,
                    to: p.to,
                    prevFrom: p.prevFrom,
                    prevTo: p.prevTo,
                    chartDays: p.chartDays,
                },
                generatedAt: new Date().toISOString(),
                kpi,
                chart,
                payments,
                couriers,
                topCustomers,
                personalDiscounts,
                failed,
            });
        } catch (e) {
            console.error("[dashboard] summary failed:", e?.sqlMessage || e?.message || e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    return router;
}
