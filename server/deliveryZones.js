import { Router } from "express";
import pool from "./db.js";

const router = Router();

// ─── Хелпер: company_id текущего пользователя по JWT ──────────────────────────
async function requireCompanyId(req) {
    // company_id может лежать прямо в токене (как у current-orders) либо в users
    const direct = req.user?.companyId;
    if (typeof direct === "number") return direct;

    const userId = req.user?.userId;
    if (!userId) {
        const err = new Error("NO_TOKEN");
        err.status = 401;
        throw err;
    }
    const [rows] = await pool.query(
        "SELECT company_id FROM users WHERE user_id = ? LIMIT 1",
        [userId]
    );
    if (!rows.length || rows[0].company_id == null) {
        const err = new Error("NO_COMPANY");
        err.status = 400;
        throw err;
    }
    return rows[0].company_id;
}

// Схема БД ведётся вручную. SQL для создания таблицы и добавления колонок —
// в deliveryappServer/migrations/delivery_zones.sql. Автоматических
// CREATE TABLE / ALTER TABLE в рантайме здесь намеренно нет.

// Евро из формы → центы в БД. Пустое значение = правило не задано (NULL).
function toCents(value) {
    if (value == null || value === '') return null;
    const n = Number(String(value).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
}

// ─── Нормализация/валидация геометрии (GeoJSON Polygon / MultiPolygon) ────────
function isValidGeometry(g) {
    if (!g || typeof g !== "object") return false;
    if (g.type !== "Polygon" && g.type !== "MultiPolygon") return false;
    return Array.isArray(g.coordinates) && g.coordinates.length > 0;
}

function rowToZone(r) {
    let geometry = null;
    try {
        geometry = typeof r.geojson === "string" ? JSON.parse(r.geojson) : r.geojson;
    } catch {
        geometry = null;
    }
    return {
        id: r.zone_id,
        name: r.name,
        color: r.color,
        fee: r.fee_cents != null ? Number(r.fee_cents) / 100 : null,
        // Правила по сумме заказа. null = правило не задано.
        minOrder: r.min_order_cents != null ? Number(r.min_order_cents) / 100 : null,
        freeFrom: r.free_from_cents != null ? Number(r.free_from_cents) / 100 : null,
        geometry,
    };
}

// ─── GET /api/delivery-zones — список зон компании ───────────────────────────
router.get("/", async (req, res) => {
    try {
        const companyId = await requireCompanyId(req);
        const [rows] = await pool.query(
            `SELECT zone_id, company_id, name, color, fee_cents,
                    min_order_cents, free_from_cents, geojson, sort_order
               FROM delivery_zones
              WHERE company_id = ?
              ORDER BY sort_order ASC, zone_id ASC`,
            [companyId]
        );
        res.json({ ok: true, zones: rows.map(rowToZone) });
    } catch (e) {
        // Без лога причина не видна ни в консоли сервера, ни оператору:
        // например «Unknown column min_order_cents» = не применена миграция.
        console.error("[zones] GET failed:", e?.sqlMessage || e?.message || e);
        const status = e.status || 500;
        res.status(status).json({ ok: false, error: e.sqlMessage || e.message || "server error" });
    }
});

// ─── PUT /api/delivery-zones — заменить весь набор зон компании ───────────────
// body: { zones: [{ name, color, fee, geometry }] }
router.put("/", async (req, res) => {
    let conn;
    try {
        const companyId = await requireCompanyId(req);

        const incoming = Array.isArray(req.body?.zones) ? req.body.zones : [];
        // отбрасываем зоны без корректной геометрии
        const clean = incoming
            .filter((z) => isValidGeometry(z?.geometry))
            .map((z, i) => ({
                name: String(z.name ?? "Зона").slice(0, 120) || "Зона",
                color: /^#[0-9a-fA-F]{3,8}$/.test(z.color) ? z.color : "#3B82F6",
                fee_cents:
                    z.fee != null && Number.isFinite(Number(z.fee))
                        ? Math.round(Number(z.fee) * 100)
                        : null,
                min_order_cents: toCents(z.minOrder),
                free_from_cents: toCents(z.freeFrom),
                geojson: JSON.stringify(z.geometry),
                sort_order: i,
            }));

        conn = await pool.getConnection();
        await conn.beginTransaction();
        await conn.query("DELETE FROM delivery_zones WHERE company_id = ?", [companyId]);

        for (const z of clean) {
            await conn.query(
                `INSERT INTO delivery_zones
                    (company_id, name, color, fee_cents, min_order_cents, free_from_cents, geojson, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [companyId, z.name, z.color, z.fee_cents, z.min_order_cents, z.free_from_cents, z.geojson, z.sort_order]
            );
        }
        await conn.commit();

        const [rows] = await pool.query(
            `SELECT zone_id, company_id, name, color, fee_cents,
                    min_order_cents, free_from_cents, geojson, sort_order
               FROM delivery_zones
              WHERE company_id = ?
              ORDER BY sort_order ASC, zone_id ASC`,
            [companyId]
        );
        res.json({ ok: true, zones: rows.map(rowToZone) });
    } catch (e) {
        if (conn) {
            try { await conn.rollback(); } catch {}
        }
        console.error("[zones] PUT failed:", e?.sqlMessage || e?.message || e);
        const status = e.status || 500;
        res.status(status).json({ ok: false, error: e.sqlMessage || e.message || "server error" });
    } finally {
        if (conn) conn.release();
    }
});

export default router;
