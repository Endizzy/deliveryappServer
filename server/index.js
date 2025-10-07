import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { getUser } from "./getUser.js";
import menuApi from "./menuApi.js";
import { WebSocketServer } from 'ws';
import { register, login, authMiddleware } from './auth.js';
import path from "path";
import { fileURLToPath } from "url";
import { listUnits, createUnit, updateUnit, deleteUnit } from "./companyUnits.js";
import { getCouriers, searchMenuItems, getPickupPoints } from "./orderSupport.js";
import currentOrdersRouter from "./currentOrder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 4000;
const app = express();

// --- CORS / статика ---
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

// Health check
app.get('/health', (_, res) => res.send('OK'));

// === АВТОРИЗАЦИЯ ===
app.post("/api/auth/register", register);
app.post("/api/auth/login", login);
app.get("/api/profile", authMiddleware, (req, res) => {
    res.json({ ok: true, user: req.user });
});

// === WS broadcaster (используется currentOrdersRouter ниже) ===
function broadcastToAdmins(payload) {
    const msg = JSON.stringify(payload);
    wss.clients.forEach((ws) => {
        if (ws.readyState === ws.OPEN && ws.clientType === 'admin') ws.send(msg);
    });
}

// === CURRENT ORDERS API ===
app.use("/api/current-orders", authMiddleware, currentOrdersRouter({ broadcastToAdmins }));

// === ВСПОМОГАТЕЛЬНЫЕ РОУТЫ ДЛЯ ЗАКАЗОВ ===
app.get("/api/order-support/couriers",      authMiddleware, getCouriers);
app.get("/api/order-support/pickup-points", authMiddleware, getPickupPoints);
app.get("/api/order-support/menu",          authMiddleware, searchMenuItems);

// === МЕНЮ ===
app.use("/api/menu", authMiddleware, menuApi);

// === ПОЛЬЗОВАТЕЛИ ===
app.get("/api/user/me", authMiddleware, getUser);

// === STAFF (company_units) ===
app.get("/api/staff",        authMiddleware, listUnits);
app.post("/api/staff",       authMiddleware, createUnit);
app.put("/api/staff/:id",    authMiddleware, updateUnit);
app.delete("/api/staff/:id", authMiddleware, deleteUnit);

const state = new Map(); // { [courierId]: { lat,lng,speedKmh,timestamp,orderId,status } }
const orders = new Map();
let nextOrderId = 1;

app.get('/api/orders', (_, res) => res.json(Array.from(orders.values())));
app.post('/api/orders', (req, res) => {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const order = { id: nextOrderId++, title, status: 'new', courierId: null };
    orders.set(order.id, order);
    res.json(order);
    broadcastToAdmins({ type: 'demo_order_created', order });
});
app.put('/api/orders/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!orders.has(id)) return res.status(404).json({ error: 'not found' });
    const existing = orders.get(id);
    const updated = { ...existing, ...req.body, id };
    orders.set(id, updated);
    res.json(updated);
    broadcastToAdmins({ type: 'demo_order_updated', order: updated });
});
app.delete('/api/orders/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!orders.has(id)) return res.status(404).json({ error: 'not found' });
    orders.delete(id);
    res.json({ ok: true });
    broadcastToAdmins({ type: 'demo_order_deleted', orderId: id });
});

// === WS ===
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function parseJsonSafe(raw) {
    try { return JSON.parse(raw); } catch { return null; }
}

wss.on('connection', (ws) => {
    ws.clientType = 'unknown';

    ws.on('message', (raw) => {
        const data = parseJsonSafe(raw);
        if (!data) return;

        if (data.type === 'hello') {
            ws.clientType = data.role === 'admin' ? 'admin' : 'courier';

            if (ws.clientType === 'admin') {
                // Отдаём только снимок локаций курьеров (snapshot).
                const snapshot = Array.from(state.entries())
                    .map(([courierId, v]) => ({ courierId, ...v }));
                ws.send(JSON.stringify({ type: 'snapshot', items: snapshot }));
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
