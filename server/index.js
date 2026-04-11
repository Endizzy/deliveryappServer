import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { getUser } from "./getUser.js";
import { getCompany } from "./getCompany.js";
import menuApi from "./menuApi.js";
import { getCustomerAddressByPhone } from "./customerAddressByPhone.js";
import { WebSocketServer } from 'ws';
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
import { getReport } from "./getReport.js";
import { getCouriers, searchMenuItems, getPickupPoints } from "./orderSupport.js";
import currentOrdersRouter from "./currentOrder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PORT       = process.env.PORT || 4000;
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
            if (ws.companyId === payload.companyId) ws.send(msg);
        } else {
            ws.send(msg);
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
    wss.clients.forEach((ws) => {
        if (ws.readyState !== ws.OPEN) return;
        if (typeof cid === 'number') {
            if (ws.companyId === cid) ws.send(msg);
        } else {
            ws.send(msg);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// broadcastToCompany(companyId, payload)             ← ДВА аргумента
// Рассылает ВСЕМ клиентам компании (admin + courier).
// Используется в mobileOrdersRouter при assign/release заказа.
// ─────────────────────────────────────────────────────────────────────────────
function broadcastToCompany(companyId, payload) {
    const msg = JSON.stringify(payload);
    if (!wss) return;
    wss.clients.forEach((ws) => {
        if (ws.readyState !== ws.OPEN) return;
        if (typeof companyId === 'number' && ws.companyId === companyId) {
            ws.send(msg);
        }
    });
}

// ─── Current Orders (admin) ──────────────────────────────────────────────────
// broadcastToAll — чтобы курьеры тоже получали order_created / order_updated
// от действий администратора (CreateOrder.jsx / EditOrder.jsx)
app.use(
    "/api/current-orders",
    authMiddleware,
    currentOrdersRouter({ broadcastToAdmins: broadcastToAll })
);

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

// ─── Staff ───────────────────────────────────────────────────────────────────
app.get("/api/staff",         authMiddleware, listUnits);
app.post("/api/staff",        authMiddleware, createUnit);
app.put("/api/staff/:id",     authMiddleware, updateUnit);
app.delete("/api/staff/:id",  authMiddleware, deleteUnit);

// ─── Demo / Location state ───────────────────────────────────────────────────
const state     = new Map(); // courierId → { lat,lng,speedKmh,timestamp,orderId,status,courierNickname }
const orders    = new Map(); // demo-orders
const unitsMeta = new Map(); // courierId → courierNickname
let nextOrderId = 1;

function parseJsonSafe(data) {
    try {
        if (Buffer.isBuffer(data)) return JSON.parse(data.toString('utf8'));
        if (typeof data === 'string') return JSON.parse(data);
        return null;
    } catch { return null; }
}

// REST: принять обновление геолокации от мобильного приложения
app.post('/api/location', (req, res) => {
    const { courierId, lat, lng, speedKmh, orderId, status, timestamp, courierNickname } = req.body || {};
    if (typeof courierId === 'undefined' || typeof lat !== 'number' || typeof lng !== 'number') {
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

    if (payload.status === 'off_shift') {
        try { state.delete(String(courierId)); } catch {}
        broadcastToAdmins({ type: 'remove', courierId: String(courierId) });
        return res.json({ ok: true });
    }

    state.set(String(courierId), { ...payload, type: undefined });
    broadcastToAdmins(payload); // геолокация — только на карту у админов
    res.json({ ok: true });
});

// Demo CRUD
app.get('/api/orders', (_, res) => res.json(Array.from(orders.values())));

app.post('/api/orders', (req, res) => {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const order = { id: nextOrderId++, title, status: 'new', courierId: null };
    orders.set(order.id, order);
    res.json(order);
    broadcastToAdmins({ type: 'order_created', order });
});

app.put('/api/orders/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!orders.has(id)) return res.status(404).json({ error: 'not found' });
    const updated = { ...orders.get(id), ...req.body, id };
    orders.set(id, updated);
    res.json(updated);
    broadcastToAdmins({ type: 'order_updated', order: updated });
});

app.delete('/api/orders/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!orders.has(id)) return res.status(404).json({ error: 'not found' });
    orders.delete(id);
    res.json({ ok: true });
    broadcastToAdmins({ type: 'order_deleted', orderId: id });
});

// ─── WebSocket Server ────────────────────────────────────────────────────────
const server = http.createServer(app);
wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    ws.clientType = 'unknown';
    ws.companyId  = null;
    ws.courierId  = null;

    ws.on('message', (raw) => {
        const data = parseJsonSafe(raw);
        if (!data) return;

        // ── Hello: регистрация клиента ──────────────────────────────────
        if (data.type === 'hello') {
            ws.clientType = data.role === 'admin' ? 'admin' : 'courier';

            const cid    = Number(data.companyId);
            ws.companyId = Number.isFinite(cid) ? cid : null;

            if (ws.clientType === 'courier' && typeof data.courierId !== 'undefined') {
                ws.courierId = String(data.courierId);
                if (data.courierNickname) {
                    try { unitsMeta.set(String(data.courierId), String(data.courierNickname)); } catch {}
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
                ws.send(JSON.stringify({ type: 'snapshot', items: snapshot }));
                ws.send(JSON.stringify({ type: 'orders_snapshot', items: Array.from(orders.values()) }));
            }
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

            state.set(String(courierId), { ...payload, type: undefined });
            broadcastToAdmins(payload); // геолокация — только на карту у админов
        }
    });

    ws.on('close', () => {
        ws.clientType = 'unknown';
        ws.companyId  = null;
        ws.courierId  = null;
    });

    ws.on('error', (err) => {
        console.warn('WS connection error', err?.message ?? err);
    });
});

server.listen(PORT, () => {
    console.log(`HTTP + WS server running on port ${PORT}`);
});