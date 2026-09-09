import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import cron from 'node-cron';
import { getUser } from "./getUser.js";
import { getCompany } from "./getCompany.js";
import menuApi from "./menuApi.js";
import { getCustomerAddressByPhone } from "./customerAddressByPhone.js";
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { activatePreorders } from "./jobs/activatePreorders.js";
import {
    register,
    login,
    courierlogin,
    authMiddleware,
    setup2FA,
    verifySetup2FA,
    disable2FA,
    get2FAStatus,
    verifyLogin2FA
} from './auth.js';
import mobileOrdersRouter from "./mobileOrdersRouter.js";
import path from "path";
import { fileURLToPath } from "url";
import { listUnits, createUnit, updateUnit, deleteUnit } from "./companyUnits.js";
import { getReport, getMobileTodayReport } from "./getReport.js";
import { getCouriers, searchMenuItems, getPickupPoints } from "./orderSupport.js";
import currentOrdersRouter, { PAYMENT_METHODS, isPreorderNotYetActive } from "./currentOrder.js";
import deliveryZonesRouter from "./deliveryZones.js";
import createCustomersRouter from "./customers.js";
import { getInvoiceSettings, saveInvoiceSettings } from "./invoiceSettings.js";
import {
    savePushToken,
    deletePushTokensByUnit,
    sendOrderPush,
} from "./services/pushService.js";
import {
    geoapifyGeocodeByText,
    geoapifyReverseGeocode,
    buildAddressText,
} from "./services/geoapify/geoapify.js";
import { etaOnCourierLocation } from "./services/eta/etaService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PORT       = process.env.PORT || 4000;
// Тот же секрет, что в auth.js — WS-hello проверяется тем же JWT
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key";
const app        = express();

// ─── CORS / static ───────────────────────────────────────────────────────────
app.use(
    "/companyLogo",
    express.static(path.join(__dirname, "companyLogo"), {
        setHeaders(res) {
            res.set("Cache-Control", "public, max-age=31536000, immutable");
        },
    })
);

app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
}));
app.options("*", cors());
app.use(express.json());

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.send('OK'));

// ─── Auth / Profile ──────────────────────────────────────────────────────────
app.post("/api/auth/register",         register);
app.post("/api/auth/login",            login);
app.post("/api/auth/courierlogin",     courierlogin);
app.get("/api/profile", authMiddleware, (req, res) => res.json({ ok: true, user: req.user }));

// ─── 2FA ─────────────────────────────────────────────────────────────────────
app.post("/api/auth/2fa/setup",        authMiddleware, setup2FA);
app.post("/api/auth/2fa/verify-setup", authMiddleware, verifySetup2FA);
app.post("/api/auth/2fa/disable",      authMiddleware, disable2FA);
app.get("/api/auth/2fa/status",        authMiddleware, get2FAStatus);
app.post("/api/auth/2fa/verify-login", verifyLogin2FA);

// WSS объявляем заранее, чтобы broadcast-функции были доступны до регистрации роутов
let wss;

// Безопасная отправка: исключение на одном сокете не должно прервать рассылку остальным
function safeSend(ws, msg) {
    try { ws.send(msg); return true; } catch (e) {
        console.warn('[ws] send failed:', e?.message ?? e);
        return false;
    }
}

// ─── Логирование WS ──────────────────────────────────────────────────────────
// Цель — по логу отвечать на вопрос «почему курьер не увидел заказ»:
// кто был подключён в момент рассылки и скольким она реально ушла.
// Геолокация (location/eta) не логируется — она идёт непрерывным потоком.
function wsClientsSummary() {
    let admins = 0, couriers = 0;
    if (!wss) return { admins, couriers };
    for (const c of wss.clients) {
        if (c.readyState !== c.OPEN) continue;
        if (c.clientType === 'admin') admins++;
        else if (c.clientType === 'courier') couriers++;
    }
    return { admins, couriers };
}

function logBroadcast(payload, sent) {
    const type = payload?.type;
    if (typeof type !== 'string' || !type.startsWith('order_')) return; // без шума от location/eta
    const { admins, couriers } = wsClientsSummary();
    const orderId = payload?.order?.id ?? payload?.orderId ?? '?';
    console.log(
        `[ws] broadcast ${type} order=${orderId} company=${payload?.companyId ?? '-'} ` +
        `→ доставлено ${sent} (онлайн: ${admins} admin, ${couriers} courier)`
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// broadcastToAdmins
// Рассылает ТОЛЬКО администраторам. Используется для геолокации курьеров (карта).
// ─────────────────────────────────────────────────────────────────────────────
function broadcastToAdmins(payload) {
    const msg = JSON.stringify(payload);
    if (!wss) return;
    wss.clients.forEach((ws) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.clientType !== 'admin') return;
        if (typeof payload?.companyId === 'number') {
            if (ws.companyId === payload.companyId) safeSend(ws, msg);
        } else {
            safeSend(ws, msg);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// broadcastToAll(payload)                            ← ОДИН аргумент
// Рассылает ВСЕМ клиентам компании (admin + courier).
// companyId берётся из payload.companyId.
//
// Передаётся в currentOrdersRouter как broadcastToAdmins, потому что
// currentOrdersRouter вызывает его одним аргументом:
//   broadcastToAdmins({ type, order, companyId })
//
// Это позволяет курьерам получать order_created / order_updated
// когда администратор создаёт или редактирует заказ через CreateOrder / EditOrder.
// ─────────────────────────────────────────────────────────────────────────────
function broadcastToAll(payload) {
    const msg = JSON.stringify(payload);
    if (!wss) return;
    const cid = payload?.companyId;

    // Предзаказ, до которого ещё далеко, курьерам не показываем: в их списке
    // его всё равно нет (фильтр в mobileOrdersRouter), а WS-событие подмешало
    // бы заказ в обход фильтра. Диспетчеры получают событие как раньше —
    // им предзаказы нужны сразу.
    const adminsOnly = isPreorderNotYetActive(payload?.order);

    let sent = 0;
    wss.clients.forEach((ws) => {
        if (ws.readyState !== ws.OPEN) return;
        if (adminsOnly && ws.clientType !== 'admin') return;
        if (typeof cid === 'number') {
            if (ws.companyId === cid && safeSend(ws, msg)) sent++;
        } else if (safeSend(ws, msg)) {
            sent++;
        }
    });
    logBroadcast(payload, sent);
}

// ─────────────────────────────────────────────────────────────────────────────
// broadcastToCompany(companyId, payload)             ← ДВА аргумента
// Рассылает ВСЕМ клиентам компании (admin + courier).
// Используется в mobileOrdersRouter при assign/release заказа.
// ─────────────────────────────────────────────────────────────────────────────
function broadcastToCompany(companyId, payload) {
    const msg = JSON.stringify(payload);
    if (!wss) return;
    let sent = 0;
    wss.clients.forEach((ws) => {
        if (ws.readyState !== ws.OPEN) return;
        if (typeof companyId === 'number' && ws.companyId === companyId) {
            if (safeSend(ws, msg)) sent++;
        }
    });
    logBroadcast({ ...payload, companyId }, sent);
}

// ─── Current Orders (admin) ──────────────────────────────────────────────────
// broadcastToAll — чтобы курьеры тоже получали order_created / order_updated
// от действий администратора (CreateOrder.jsx / EditOrder.jsx)
//
// broadcastAndPush — аддитивная обёртка: помимо WS, при создании заказа
// (order_created) отправляет push-уведомление курьерам компании. WS-логику
// не меняем — currentOrder.js по-прежнему вызывает один аргумент.
function broadcastAndPush(payload) {
    broadcastToAll(payload);
    if (typeof payload?.companyId !== "number") return;

    // Заказ ещё не пора нести курьеру — молчим. Иначе курьер получил бы
    // «Новый заказ» о заказе, которого нет в его списке: хуже, чем ничего.
    // Push придёт в момент активации, ветка preorderActivated ниже.
    if (isPreorderNotYetActive(payload.order)) return;

    // Сюда попадает и активация предзаказа: джоба присылает order_created,
    // потому что для курьера заказ появляется именно в этот момент.
    // sendOrderPush сам разберётся с адресатом — свободный заказ уйдёт всем
    // курьерам, назначенный только своему (по courierId в заказе).
    //
    // Если приложение открыто и сокет живой, этот push будет подавлен
    // обработчиком в pushNotifications.js: заказ уже озвучен по WS, и
    // claimOrderNotification не даст сработать второму сигналу.
    if (payload.type === "order_created") {
        sendOrderPush(payload.companyId, payload.order);
        return;
    }

    // Заказ существовал и только что закреплён за курьером (админ выбрал
    // исполнителя в EditOrder). Раньше такое назначение проходило совсем
    // незаметно: push слался только при создании заказа.
    if (payload.type === "order_updated" && payload.courierAssigned) {
        const courierId = payload.order?.courierId ?? null;
        if (courierId != null) {
            sendOrderPush(payload.companyId, payload.order, { onlyUnitId: courierId });
        }
    }
}

app.use(
    "/api/current-orders",
    authMiddleware,
    currentOrdersRouter({ broadcastToAdmins: broadcastAndPush })
);

// ─── Push notifications (courier devices) ────────────────────────────────────
app.post("/api/push/register-token", authMiddleware, async (req, res) => {
    try {
        const { token, platform } = req.body || {};
        console.log(`[push] register-token hit: unit=${req.user?.userId} company=${req.user?.companyId} platform=${platform} token=${String(token).slice(0, 24)}...`);
        if (!token || typeof token !== "string") {
            return res.status(400).json({ ok: false, error: "token required" });
        }
        const unitId = req.user?.userId;
        const companyId = req.user?.companyId;
        if (!unitId || typeof companyId !== "number") {
            console.warn(`[push] register-token unauthorized: unit=${unitId} company=${companyId}`);
            return res.status(401).json({ ok: false, error: "unauthorized" });
        }
        await savePushToken({ unitId, companyId, token, platform });
        console.log(`[push] token saved for unit=${unitId} company=${companyId}`);
        res.json({ ok: true });
    } catch (e) {
        console.error("[push] register-token error:", e);
        res.status(500).json({ ok: false, error: "server error" });
    }
});

app.post("/api/push/unregister-token", authMiddleware, async (req, res) => {
    try {
        await deletePushTokensByUnit(req.user?.userId);
        res.json({ ok: true });
    } catch (e) {
        console.error("unregister-token", e);
        res.status(500).json({ ok: false, error: "server error" });
    }
});

// ─── Geocoding (для проверки адреса на карте при создании заказа) ────────────
// Прокси к Geoapify: ключ остаётся на сервере и не попадает в браузерный бандл.
app.post("/api/geocode", authMiddleware, async (req, res) => {
    try {
        const b = req.body || {};
        const text =
            typeof b.text === "string" && b.text.trim()
                ? b.text.trim()
                : buildAddressText(b);
        if (!text) {
            return res.status(400).json({ ok: false, error: "address required" });
        }
        const geo = await geoapifyGeocodeByText(text);
        if (!geo.ok) {
            return res.status(502).json({ ok: false, error: geo.error });
        }
        res.json({
            ok: true,
            lat: geo.lat,
            lng: geo.lng,
            formatted: geo.raw?.formatted ?? text,
        });
    } catch (e) {
        console.error("[geocode] error:", e?.message ?? e);
        res.status(500).json({ ok: false, error: "server error" });
    }
});

app.post("/api/reverse-geocode", authMiddleware, async (req, res) => {
    try {
        const lat = Number(req.body?.lat);
        const lng = Number(req.body?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return res.status(400).json({ ok: false, error: "lat/lng required" });
        }
        const geo = await geoapifyReverseGeocode(lat, lng);
        if (!geo.ok) {
            return res.status(502).json({ ok: false, error: geo.error });
        }
        res.json({ ok: true, lat: geo.lat, lng: geo.lng, formatted: geo.formatted });
    } catch (e) {
        console.error("[reverse-geocode] error:", e?.message ?? e);
        res.status(500).json({ ok: false, error: "server error" });
    }
});

// ─── Delivery Zones (admin) ──────────────────────────────────────────────────
app.use("/api/delivery-zones", authMiddleware, deliveryZonesRouter);

// ─── Customers (контроль клиентов, admin) ────────────────────────────────────
app.use("/api/customers", authMiddleware, createCustomersRouter());

// ─── Invoice settings (реквизиты накладной, per-company) ─────────────────────
app.get("/api/invoice-settings", authMiddleware, getInvoiceSettings);
app.post("/api/invoice-settings", authMiddleware, saveInvoiceSettings);

// ─── Mobile Orders (couriers) ────────────────────────────────────────────────
// broadcastToCompany — для assign/release (два аргумента: companyId, payload)
app.use(
    "/api/mobile-orders",
    authMiddleware,
    mobileOrdersRouter({ broadcastToCompany })
);

// ─── Order support ───────────────────────────────────────────────────────────
app.get("/api/order-support/couriers",      authMiddleware, getCouriers);
app.get("/api/order-support/pickup-points", authMiddleware, getPickupPoints);
app.get("/api/order-support/menu",          authMiddleware, searchMenuItems);
app.get("/api/order-support/customer-address-by-phone", authMiddleware, getCustomerAddressByPhone);

// ─── Menu ────────────────────────────────────────────────────────────────────
app.use("/api/menu", authMiddleware, menuApi);

// ─── User / Company ──────────────────────────────────────────────────────────
app.get("/api/user/me",    authMiddleware, getUser);
app.get("/api/company/me", authMiddleware, getCompany);

// ─── Report ──────────────────────────────────────────────────────────────────
app.get("/api/report", authMiddleware, getReport);
app.get("/api/mobile-report", authMiddleware, getMobileTodayReport);

// ─── Staff ───────────────────────────────────────────────────────────────────
app.get("/api/staff",         authMiddleware, listUnits);
app.post("/api/staff",        authMiddleware, createUnit);
app.put("/api/staff/:id",     authMiddleware, updateUnit);
app.delete("/api/staff/:id",  authMiddleware, deleteUnit);

// ─── Location state ──────────────────────────────────────────────────────────
const state     = new Map(); // courierId → { lat,lng,speedKmh,timestamp,orderId,status,courierNickname }
const unitsMeta = new Map(); // courierId → courierNickname

function parseJsonSafe(data) {
    try {
        if (Buffer.isBuffer(data)) return JSON.parse(data.toString('utf8'));
        if (typeof data === 'string') return JSON.parse(data);
        return null;
    } catch { return null; }
}

// REST: принять обновление геолокации от мобильного приложения.
// authMiddleware обязателен: иначе разлогиненное приложение (или кто угодно)
// может слать координаты, и на карте появляются «зомби»-курьеры.
app.post('/api/location', authMiddleware, (req, res) => {
    const { courierId, lat, lng, speedKmh, orderId, status, timestamp, courierNickname } = req.body || {};

    if (typeof courierId === 'undefined') {
        return res.status(400).json({ ok: false, error: 'bad payload' });
    }

    // off_shift (конец смены / выход) обрабатываем СРАЗУ и БЕЗ координат —
    // курьер должен исчезнуть с карты мгновенно, даже если позиции нет.
    if (status === 'off_shift') {
        try { state.delete(String(courierId)); } catch {}
        broadcastToAdmins({ type: 'remove', courierId: String(courierId) });
        return res.json({ ok: true });
    }

    // Для обычного апдейта координаты обязательны.
    if (typeof lat !== 'number' || typeof lng !== 'number') {
        return res.status(400).json({ ok: false, error: 'bad payload' });
    }

    if (courierNickname) {
        try { unitsMeta.set(String(courierId), String(courierNickname)); } catch {}
    }

    const nickname = unitsMeta.get(String(courierId)) ?? null;

    const payload = {
        type:            'location',
        courierId:       String(courierId),
        lat,
        lng,
        speedKmh:        typeof speedKmh === 'number' ? speedKmh : null,
        orderId:         orderId ?? null,
        status:          status ?? 'unknown',
        timestamp:       timestamp || new Date().toISOString(),
        courierNickname: nickname,
    };

    state.set(String(courierId), { ...payload, type: undefined, receivedAt: Date.now() });
    broadcastToAdmins(payload); // геолокация — только на карту у админов
    etaOnCourierLocation(payload, broadcastToAdmins); // fire-and-forget, внутри троттлинг
    res.json({ ok: true });
});

// ─── TTL-очистка курьеров ────────────────────────────────────────────────────
// Если от курьера нет координат дольше STALE_COURIER_MS (приложение убито,
// потеря сети, разлогин без прощального off_shift) — убираем метку с карты.
const STALE_COURIER_MS = Number(process.env.STALE_COURIER_MS || 5 * 60 * 1000);
setInterval(() => {
    const now = Date.now();
    for (const [courierId, v] of state.entries()) {
        if (now - (v?.receivedAt ?? 0) > STALE_COURIER_MS) {
            state.delete(courierId);
            broadcastToAdmins({ type: 'remove', courierId });
        }
    }
}, 60000);

// ─── WebSocket Server ────────────────────────────────────────────────────────
const server = http.createServer(app);
wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    ws.clientType = 'unknown';
    ws.companyId  = null;
    ws.courierId  = null;

    // Heartbeat: считаем соединение живым, пока приходят pong (или любые данные)
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        ws.isAlive = true; // любое сообщение — признак живого соединения
        const data = parseJsonSafe(raw);
        if (!data) return;

        // ── Hello: регистрация клиента (только по валидному JWT) ────────
        if (data.type === 'hello') {
            let payload;
            try {
                payload = jwt.verify(String(data.token || ''), JWT_SECRET);
            } catch (err) {
                // Невалидный/просроченный/отсутствующий токен — клиент должен
                // перелогиниться, а не реконнектиться (код 4401).
                const why = !data.token ? 'нет токена'
                    : err?.name === 'TokenExpiredError' ? 'токен просрочен'
                    : 'токен невалиден';
                console.warn(`[ws] ✗ hello отклонён (${why}) role=${data.role ?? '-'}`);
                try { ws.close(4401, 'unauthorized'); } catch {}
                return;
            }

            // Роль и companyId берём ТОЛЬКО из токена, а не со слов клиента
            ws.clientType = payload.role === 'courier' ? 'courier' : 'admin';

            const cid    = Number(payload.companyId);
            ws.companyId = Number.isFinite(cid) ? cid : null;

            if (ws.clientType === 'courier') {
                ws.courierId = String(payload.userId);
                const nick = payload.unitNickname ?? data.courierNickname;
                if (nick) {
                    try { unitsMeta.set(ws.courierId, String(nick)); } catch {}
                }
            }

            if (ws.clientType === 'admin') {
                // Снапшот геолокаций курьеров — только для админов
                const snapshot = Array.from(state.entries()).map(([courierId, v]) => ({
                    courierId,
                    lat:             v.lat,
                    lng:             v.lng,
                    speedKmh:        v.speedKmh  ?? null,
                    orderId:         v.orderId   ?? null,
                    status:          v.status    ?? 'unknown',
                    timestamp:       v.timestamp ?? new Date().toISOString(),
                    courierNickname: v.courierNickname ?? unitsMeta.get(String(courierId)) ?? null,
                }));
                safeSend(ws, JSON.stringify({ type: 'snapshot', items: snapshot }));
            }

            safeSend(ws, JSON.stringify({ type: 'hello_ok' }));

            {
                const { admins, couriers } = wsClientsSummary();
                const who = ws.clientType === 'courier'
                    ? `courier=${ws.courierId}${payload.unitNickname ? ` (${payload.unitNickname})` : ''}`
                    : `admin user=${payload.userId}`;
                console.log(
                    `[ws] + подключён ${who} company=${ws.companyId} ` +
                    `(онлайн: ${admins} admin, ${couriers} courier)`
                );
            }
            return;
        }

        // До успешного hello никакие другие сообщения не принимаем
        if (ws.clientType === 'unknown') return;

        // ── App-level ping ───────────────────────────────────────────────
        // Протокольный ping/pong (ws.ping) обрабатывается нативным слоем и
        // невидим для JS в React Native, поэтому мобильный клиент не может
        // по нему судить о живости канала. Отвечаем на JSON-ping: пришедший
        // pong — единственное для телефона доказательство, что связь есть.
        if (data.type === 'ping') {
            safeSend(ws, JSON.stringify({ type: 'pong', ts: data.ts ?? null }));
            return;
        }

        // ── Локация от курьера по WS ─────────────────────────────────────
        if (data.type === 'location' && ws.clientType !== 'admin') {
            const { courierId, lat, lng, speedKmh, orderId, status, timestamp, courierNickname } = data;
            if (typeof courierId === 'undefined' || typeof lat !== 'number' || typeof lng !== 'number') return;

            if (courierNickname) {
                try { unitsMeta.set(String(courierId), String(courierNickname)); } catch {}
            }

            const payload = {
                type:            'location',
                courierId,
                lat,
                lng,
                speedKmh:        typeof speedKmh === 'number' ? speedKmh : null,
                orderId:         orderId  ?? null,
                status:          status   ?? 'unknown',
                timestamp:       timestamp || new Date().toISOString(),
                courierNickname: unitsMeta.get(String(courierId)) ?? null,
            };

            if (payload.status === 'off_shift') {
                try { state.delete(String(courierId)); } catch {}
                broadcastToAdmins({ type: 'remove', courierId: String(courierId) });
                return;
            }

            state.set(String(courierId), { ...payload, type: undefined, receivedAt: Date.now() });
            broadcastToAdmins(payload); // геолокация — только на карту у админов
            etaOnCourierLocation(payload, broadcastToAdmins); // fire-and-forget, внутри троттлинг
        }
    });

    ws.on('close', (code) => {
        // Логируем только клиентов, прошедших hello: неудачные попытки уже
        // залогированы выше, а «пустые» подключения шума не стоят.
        if (ws.clientType !== 'unknown') {
            const who = ws.clientType === 'courier' ? `courier=${ws.courierId}` : 'admin';
            // 1000/1005 — штатное закрытие, 1006 — обрыв связи, 4401 — отказ авторизации
            const reason = code === 1006 ? 'обрыв связи'
                : code === 4401 ? 'отказ авторизации'
                : ws.killedByHeartbeat ? 'не отвечал на ping'
                : 'штатно';
            console.log(`[ws] − отключён ${who} company=${ws.companyId} code=${code} (${reason})`);
        }
        ws.clientType = 'unknown';
        ws.companyId  = null;
        ws.courierId  = null;
    });

    ws.on('error', (err) => {
        console.warn('[ws] connection error:', err?.message ?? err);
    });
});

// ─── WS Heartbeat ────────────────────────────────────────────────────────────
// 1) Обнаруживает полумёртвые соединения (смена сети, обрыв без FIN):
//    нет pong за цикл → terminate, клиент получает onclose и реконнектится.
// 2) Генерирует трафик чаще, чем idle-таймаут Cloudflare (~100 c),
//    иначе туннель молча режет «тихие» соединения.
// Браузер и React Native отвечают pong на протокольный ping автоматически.
const WS_HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS || 30_000);
const heartbeatTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            if (ws.clientType !== 'unknown') {
                const who = ws.clientType === 'courier' ? `courier=${ws.courierId}` : 'admin';
                console.warn(`[ws] ✗ мёртвое соединение ${who} company=${ws.companyId} — terminate`);
            }
            ws.killedByHeartbeat = true; // для расшифровки причины в обработчике close
            try { ws.terminate(); } catch {}
            return;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
    });
}, WS_HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeatTimer));

// ─── Cron Job: Активация предзаказов каждую минуту ──────────────────────────
// Предзаказы становятся активными за 2 часа до scheduled_at
const cronJob = cron.schedule('* * * * *', async () => {
    try {
        await activatePreorders(broadcastAndPush);
    } catch (err) {
        console.error('[Cron] activatePreorders error:', err?.message ?? err);
    }
});

console.log('[Cron] ✅ activatePreorders job scheduled (every minute)');

server.listen(PORT, () => {
    console.log(`HTTP + WS server running on port ${PORT}`);
    // Отпечаток сборки: по этой строке в `docker logs` сразу видно, свежий код
    // в контейнере или старый, — без захода внутрь и grep по файлам.
    console.log(`[boot] способы оплаты: ${PAYMENT_METHODS.join(", ")}`);
});
