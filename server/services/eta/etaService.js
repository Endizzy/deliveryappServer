// Расчёт ETA курьера до адреса его активного заказа через osrm-eta-service.
//
// Вызывается на каждое обновление геолокации курьера (REST и WS),
// но реально ходит в ETA-сервис только по триггеру:
//   - курьер сместился больше чем на ETA_MIN_MOVE_M метров, ИЛИ
//   - с прошлого расчёта прошло больше ETA_MIN_INTERVAL_MS.
//
// Результат рассылается админам через broadcast: { type: "eta", ... }.
// Когда активного заказа больше нет — { type: "eta_clear", ... }.

import pool from "../../db.js";

const ETA_URL = (process.env.ETA_SERVICE_URL || "http://localhost:3001").replace(/\/+$/, "");
const ETA_KEY = process.env.ETA_SERVICE_KEY || "";
const MIN_INTERVAL_MS = Number(process.env.ETA_MIN_INTERVAL_MS || 30000);
const MIN_MOVE_M = Number(process.env.ETA_MIN_MOVE_M || 250);

// courierId -> { lat, lng, at, orderId }
const lastByCourier = new Map();
let lastErrorLogAt = 0;

function haversineM(lat1, lng1, lat2, lng2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Активный заказ курьера с координатами. enroute приоритетнее ready.
async function findActiveOrder(courierId) {
    const [rows] = await pool.query(
        `SELECT order_id, company_id, address_lat, address_lng, status
           FROM current_orders
          WHERE courier_unit_id = ?
            AND status IN ('ready','enroute')
            AND address_lat IS NOT NULL AND address_lng IS NOT NULL
          ORDER BY (status = 'enroute') DESC, order_id DESC
          LIMIT 1`,
        [courierId]
    );
    return rows?.[0] ?? null;
}

function logErrorThrottled(msg) {
    const now = Date.now();
    if (now - lastErrorLogAt > 60000) {
        lastErrorLogAt = now;
        console.warn(`[eta] ${msg}`);
    }
}

export async function etaOnCourierLocation(loc, broadcast) {
    try {
        const courierId = String(loc?.courierId ?? "");
        const lat = Number(loc?.lat);
        const lng = Number(loc?.lng);
        if (!courierId || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

        // троттлинг: не дёргаем сервис на каждый GPS-тик
        const prev = lastByCourier.get(courierId);
        const now = Date.now();
        if (
            prev &&
            now - prev.at < MIN_INTERVAL_MS &&
            haversineM(prev.lat, prev.lng, lat, lng) < MIN_MOVE_M
        ) {
            return;
        }

        const order = await findActiveOrder(Number(courierId) || courierId);

        if (!order) {
            // заказ доставлен/снят — убираем ETA с карты
            if (prev?.orderId != null) {
                broadcast({
                    type: "eta_clear",
                    courierId,
                    orderId: prev.orderId,
                    companyId: prev.companyId,
                });
            }
            lastByCourier.set(courierId, { lat, lng, at: now, orderId: null });
            return;
        }

        const url =
            `${ETA_URL}/api/eta` +
            `?fromLat=${lat}&fromLng=${lng}` +
            `&toLat=${Number(order.address_lat)}&toLng=${Number(order.address_lng)}`;
        const res = await fetch(url, {
            headers: ETA_KEY ? { "x-api-key": ETA_KEY } : {},
        });
        const data = await res.json().catch(() => null);
        if (!data?.ok) {
            logErrorThrottled(`service error: ${data?.error ?? `HTTP ${res.status}`}`);
            return;
        }

        lastByCourier.set(courierId, {
            lat,
            lng,
            at: now,
            orderId: order.order_id,
            companyId: order.company_id,
        });

        broadcast({
            type: "eta",
            companyId: order.company_id, // фильтр по компании в broadcastToAdmins
            courierId,
            orderId: order.order_id,
            orderStatus: order.status,
            durationSec: data.durationSec,
            scale: data.scale,
            totalSec: data.totalSec,
            distanceM: data.distanceM,
            etaAt: data.etaAt,
            computedAt: new Date().toISOString(),
        });
    } catch (e) {
        logErrorThrottled(`failed: ${e?.message ?? e}`);
    }
}
