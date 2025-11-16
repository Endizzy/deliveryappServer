import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { getUser } from "./getUser.js";
import menuApi from "./menuApi.js";
import { WebSocketServer } from 'ws';
import { register, login, courierlogin, authMiddleware } from './auth.js';
import path from "path";
import { fileURLToPath } from "url";
import { listUnits, createUnit, updateUnit, deleteUnit } from "./companyUnits.js";
import { getCouriers, searchMenuItems, getPickupPoints } from "./orderSupport.js";
import currentOrdersRouter from "./currentOrder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 4000;
const app = express();

// --- CORS / static ---
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

// Health
app.get('/health', (_, res) => res.send('OK'));

// === AUTH / PROFILE ===
app.post("/api/auth/register", register);
app.post("/api/auth/login", login);
app.post("/api/auth/courierlogin", courierlogin);
app.get("/api/profile", authMiddleware, (req, res) => {
    res.json({ ok: true, user: req.user });
});

// Заготовка: позже свяжем с WS (объявим ниже)
let wss;

// Функция рассылки с учётом companyId
function broadcastToAdmins(payload) {
    const msg = JSON.stringify(payload);
    if (!wss) return;

    wss.clients.forEach((ws) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.clientType !== 'admin') return;

        // Если компания указана — шлём только совпадающим
        if (typeof payload?.companyId === 'number') {
            if (ws.companyId === payload.companyId) ws.send(msg);
            return;
        }

        // Иначе (наследие/прочие типы сообщений) — шлём всем админам
        ws.send(msg);
    });
}

// === CURRENT ORDERS ===
app.use("/api/current-orders", authMiddleware, currentOrdersRouter({ broadcastToAdmins }));

// Поддержка данных для создания заказа
app.get("/api/order-support/couriers",      authMiddleware, getCouriers);
app.get("/api/order-support/pickup-points", authMiddleware, getPickupPoints);
app.get("/api/order-support/menu",          authMiddleware, searchMenuItems);

// === MENU ===
app.use("/api/menu", authMiddleware, menuApi);

// === USER ===
app.get("/api/user/me", authMiddleware, getUser);

// === STAFF ===
app.get("/api/staff",        authMiddleware, listUnits);
app.post("/api/staff",       authMiddleware, createUnit);
app.put("/api/staff/:id",    authMiddleware, updateUnit);
app.delete("/api/staff/:id", authMiddleware, deleteUnit);

// === ДЕМО/ЛОКАЦИИ (опционально) ===
const state = new Map(); // { [courierId]: { lat,lng,speedKmh,timestamp,orderId,status } }
const orders = new Map(); // демо-заказы
let nextOrderId = 1;

function parseJsonSafe(str) {
    try { return JSON.parse(str); } catch { return null; }
}

app.post('/api/location', (req, res) => {
    const { courierId, lat, lng, speedKmh, orderId, status, timestamp } = req.body || {};
    if (typeof courierId === 'undefined' || typeof lat !== 'number' || typeof lng !== 'number') {
        return res.status(400).json({ ok: false, error: 'bad payload' });
    }
    const payload = {
        type: 'location',
        courierId: String(courierId),
        lat, lng,
        speedKmh: typeof speedKmh === 'number' ? speedKmh : null,
        orderId: orderId ?? null,
        status: status ?? 'unknown',
        timestamp: timestamp || new Date().toISOString(),
    };
    state.set(String(courierId), { ...payload, type: undefined });
    broadcastToAdmins(payload);
    res.json({ ok: true });
});

// ДЕМО CRUD (оставлено как было)
app.get('/api/orders', (_, res) => res.json(Array.from(orders.values())));
app.post('/api/orders', (req, res) => {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const order = { id: nextOrderId++, title, status: 'new', courierId: null };
    orders.set(order.id, order);
    res.json(order);
    broadcastToAdmins({ type: 'order_created', order }); // без companyId — уйдёт всем админам (демо)
});
app.put('/api/orders/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!orders.has(id)) return res.status(404).json({ error: 'not found' });
    const existing = orders.get(id);
    const updated = { ...existing, ...req.body, id };
    orders.set(id, updated);
    res.json(updated);
    broadcastToAdmins({ type: 'order_updated', order: updated }); // демо
});
app.delete('/api/orders/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!orders.has(id)) return res.status(404).json({ error: 'not found' });
    orders.delete(id);
    res.json({ ok: true });
    broadcastToAdmins({ type: 'order_deleted', orderId: id }); // демо
});

// === WS ===
const server = http.createServer(app);
wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    ws.clientType = 'unknown';
    ws.companyId = null; // <— помечаем компанию соединения

    ws.on('message', (raw) => {
        const data = parseJsonSafe(raw);
        if (!data) return;

        if (data.type === 'hello') {
            ws.clientType = data.role === 'admin' ? 'admin' : 'courier';
            // важно: клиент присылает companyId, сохраняем на сокете
            const cid = Number(data.companyId);
            ws.companyId = Number.isFinite(cid) ? cid : null;

            if (ws.clientType === 'admin') {
                // можно отправлять снапшоты, но фронт их игнорирует — оставим как было
                const snapshot = Array.from(state.entries())
                    .map(([courierId, v]) => ({ courierId, ...v }));
                ws.send(JSON.stringify({ type: 'snapshot', items: snapshot }));
                ws.send(JSON.stringify({ type: 'orders_snapshot', items: Array.from(orders.values()) }));
            }
            return;
        }

        // Курьер шлёт локацию по WS
        if (data.type === 'location' && ws.clientType !== 'admin') {
            const { courierId, lat, lng, speedKmh, orderId, status, timestamp } = data;
            if (typeof courierId === 'undefined' || typeof lat !== 'number' || typeof lng !== 'number') return;

            const payload = {
                type: 'location',
                courierId,
                lat, lng,
                speedKmh: typeof speedKmh === 'number' ? speedKmh : null,
                orderId: orderId ?? null,
                status: status ?? 'unknown',
                timestamp: timestamp || new Date().toISOString()
            };

            state.set(String(courierId), { ...payload, type: undefined });
            broadcastToAdmins(payload);
        }
    });
});

server.listen(PORT, () => {
    console.log(`HTTP + WS server running on port ${PORT}`);
});
