import { Router } from "express";
import pool from "./db.js";
import { resolveCompanyContext } from "./currentOrder.js";

// ─────────────────────────────────────────────────────────────────────────────
// Аналитика заказов для руководства: где заказывают чаще.
//
// Только чтение. Ничего не создаёт и не меняет — вкладка «Анализ» не может
// повлиять на работу смены, даже если запрос отработает неверно.
// ─────────────────────────────────────────────────────────────────────────────

/** Периоды в днях. 'all' — без ограничения по дате. */
const PERIODS = { 30: 30, 90: 90, 365: 365 };

/**
 * Точность округления координат — 4 знака, примерно 11 метров.
 *
 * Зачем округлять вообще: постоянный клиент заказывает с одного адреса
 * десятки раз, и без схлопывания мы бы гоняли в браузер десятки одинаковых
 * точек. После агрегации это одна точка с n=30 — и легче, и честнее:
 * на карте видно именно адрес, а не «облако» из наложенных маркеров.
 *
 * Почему не грубее: на 3 знаках (~110 м) соседние дома слипаются в один
 * круг, и детализация при близком зуме теряется безвозвратно — клиент
 * разгруппировать обратно уже не сможет.
 */
const COORD_PRECISION = 4;

/** Рамка Латвии с запасом. Точки вне неё — брак геокодинга: они растягивают
 *  масштаб так, что весь город схлопывается в одну точку. */
const BBOX = { latMin: 55.6, latMax: 58.1, lngMin: 20.9, lngMax: 28.3 };

/** Предохранитель: даже при огромной базе браузер не должен получить
 *  сотни тысяч точек. На практике после округления столько не набирается. */
const MAX_POINTS = 20000;

export default function createAnalyticsRouter() {
    const router = Router();

    // ── GET /api/analytics/orders-map?period=30|90|365|all ───────────────────
    router.get("/orders-map", async (req, res) => {
        try {
            const ctx = await resolveCompanyContext(req, res);
            if (!ctx) return;
            const { companyId } = ctx;

            const raw = String(req.query.period ?? "365");
            const days = PERIODS[raw] ?? (raw === "all" ? null : 365);

            // Отменённые не считаем: такой заказ не состоялся, и на карте
            // спроса ему не место.
            const where = [
                "co.company_id = ?",
                "co.status <> 'cancelled'",
            ];
            const params = [companyId];

            if (days !== null) {
                // По операционному дню, как в отчётах: дата создания у
                // предзаказа отличается от дня, когда заказ реально везли.
                //
                // Колонка сравнивается напрямую, без COALESCE. Обёртка в
                // функцию сделала бы условие несравнимым по индексу: MySQL
                // ищет по индексу, только когда колонка стоит «голой» слева.
                // Пустых order_seq_date в базе нет (проверено запросом) и быть
                // не может: deriveOrderSeqDate возвращает дату в обеих ветках,
                // а INSERT заполняет колонку всегда.
                where.push("co.order_seq_date >= (CURDATE() - INTERVAL ? DAY)");
                params.push(days);
            }

            const whereSql = where.join(" AND ");

            // Общий счётчик за период — вместе с заказами без координат.
            // Нужен, чтобы честно показать, сколько заказов на карту не попало.
            const [[totals]] = await pool.query(
                `SELECT
                     COUNT(*)                                        AS total,
                     COALESCE(SUM(co.amount_total), 0)               AS revenue,
                     SUM(co.address_lat IS NULL OR co.address_lng IS NULL) AS no_coords
                 FROM current_orders co
                 WHERE ${whereSql}`,
                params
            );

            const [rows] = await pool.query(
                `SELECT
                     ROUND(co.address_lat, ?)          AS lat,
                     ROUND(co.address_lng, ?)          AS lng,
                     COUNT(*)                          AS n,
                     COALESCE(SUM(co.amount_total), 0) AS sum
                 FROM current_orders co
                 WHERE ${whereSql}
                   AND co.address_lat IS NOT NULL
                   AND co.address_lng IS NOT NULL
                   AND co.address_lat BETWEEN ? AND ?
                   AND co.address_lng BETWEEN ? AND ?
                 GROUP BY ROUND(co.address_lat, ?), ROUND(co.address_lng, ?)
                 ORDER BY n DESC
                 LIMIT ${MAX_POINTS}`,
                [
                    COORD_PRECISION, COORD_PRECISION,
                    ...params,
                    BBOX.latMin, BBOX.latMax, BBOX.lngMin, BBOX.lngMax,
                    COORD_PRECISION, COORD_PRECISION,
                ]
            );

            const points = rows.map((r) => ({
                lat: Number(r.lat),
                lng: Number(r.lng),
                n: Number(r.n) || 0,
                sum: Number(r.sum) || 0,
            }));

            const mapped = points.reduce((acc, p) => acc + p.n, 0);
            const total = Number(totals?.total) || 0;

            res.json({
                ok: true,
                period: days === null ? "all" : String(days),
                // Всего заказов за период — и сколько из них попало на карту.
                // Расхождение показываем в интерфейсе, а не прячем.
                total,
                revenue: Number(totals?.revenue) || 0,
                mapped,
                // Без координат + отсеянные как брак геокодинга
                skipped: Math.max(0, total - mapped),
                noCoords: Number(totals?.no_coords) || 0,
                truncated: rows.length >= MAX_POINTS,
                points,
            });
        } catch (e) {
            console.error("[analytics] orders-map failed:", e?.sqlMessage || e?.message || e);
            res.status(500).json({ ok: false, error: "Ошибка сервера" });
        }
    });

    return router;
}
