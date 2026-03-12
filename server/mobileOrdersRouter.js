import express from "express";
import pool from "./db.js";
import { resolveCompanyContext } from "./currentOrder.js";

function rowToMobileOrderDto(r) {
  const addr = [
    r.address_street,
    r.address_house     && `д.${r.address_house}`,
    r.address_building  && `к.${r.address_building}`,
    r.address_apartment && `кв.${r.address_apartment}`,
    r.address_floor     && `эт.${r.address_floor}`,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    id:            r.order_id,
    orderNo:       r.order_no,
    orderSeq:      r.order_seq ?? null,
    orderDay:      r.order_seq_date ?? null,
    orderType:     r.order_type,
    status:        r.status,
    createdAt:     r.created_at,
    updatedAt:     r.updated_at,
    scheduledAt:   r.scheduled_at,
    amountTotal:   Number(r.amount_total),
    deliveryFee:   Number(r.delivery_fee || 0),
    paymentMethod: r.payment_method,
    customer:      r.customer_name,
    phone:         r.customer_phone,
    address:       addr,
    outlet:        r.pickup_nickname || "",
    courierId:     r.courier_unit_id ?? null,
    courierName:   r.courier_name ?? null,
    companyId:     r.company_id,
  };
}

function safeParseItemsJSON(v) {
  try {
    if (v == null) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === "string") {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    }
    if (Buffer.isBuffer(v)) {
      const p = JSON.parse(v.toString("utf8"));
      return Array.isArray(p) ? p : [];
    }
    if (typeof v === "object") return Array.isArray(v) ? v : [];
    return [];
  } catch {
    return [];
  }
}

// Загрузить один заказ из БД с именами курьера и точки
async function fetchOrderById(companyId, orderId) {
  const [rows] = await pool.query(
    `SELECT co.*,
            cu2.unit_nickname AS pickup_nickname,
            cu3.unit_nickname AS courier_name
     FROM current_orders co
     LEFT JOIN company_units cu2 ON cu2.unit_id = co.pickup_unit_id
     LEFT JOIN company_units cu3 ON cu3.unit_id = co.courier_unit_id
     WHERE co.company_id = ? AND co.order_id = ?
     LIMIT 1`,
    [companyId, orderId]
  );
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Экспорт — фабрика, принимающая { broadcastToCompany }
// В index.js: app.use("/api/mobile-orders", authMiddleware, mobileOrdersRouter({ broadcastToCompany }));
// ─────────────────────────────────────────────────────────────────────────────
export default function mobileOrdersRouter({ broadcastToCompany }) {
  const router = express.Router();

  // ── GET /api/mobile-orders?tab=active|all|my ────────────────────────────
  router.get("/", async (req, res) => {
    try {
      const ctx = await resolveCompanyContext(req, res);
      if (!ctx) return;

      const { companyId, user } = ctx;
      const tab       = (req.query.tab || "active").toLowerCase();
      const courierId = user.unitId || user.unit_id || user.userId || null;

      const where  = ["co.company_id=?", "co.status != 'cancelled'"];
      const params = [companyId];

      if (tab === "active") {
        where.push("co.status IN ('new','ready','enroute')");
        where.push("co.courier_unit_id IS NULL");
      } else if (tab === "my") {
        if (!courierId) return res.json({ ok: true, items: [] });
        where.push("co.courier_unit_id=?");
        params.push(courierId);
      } else if (tab === "all") {
        where.push("co.courier_unit_id IS NULL");
      }

      const [rows] = await pool.query(
        `SELECT co.*,
                cu2.unit_nickname AS pickup_nickname,
                cu3.unit_nickname AS courier_name
         FROM current_orders co
         LEFT JOIN company_units cu2 ON cu2.unit_id = co.pickup_unit_id
         LEFT JOIN company_units cu3 ON cu3.unit_id = co.courier_unit_id
         WHERE ${where.join(" AND ")}
         ORDER BY co.created_at DESC, co.order_id DESC
         LIMIT 100`,
        params
      );

      res.json({ ok: true, items: rows.map(rowToMobileOrderDto) });
    } catch (e) {
      console.error("mobile orders GET /", e);
      res.status(500).json({ ok: false, error: "Ошибка сервера" });
    }
  });

  // ── GET /api/mobile-orders/:id ──────────────────────────────────────────
  router.get("/:id", async (req, res) => {
    try {
      const ctx = await resolveCompanyContext(req, res);
      if (!ctx) return;

      const { companyId, user } = ctx;
      const id        = Number(req.params.id);
      const courierId = user.unitId || user.unit_id || user.userId || null;

      const r = await fetchOrderById(companyId, id);
      if (!r) return res.status(404).json({ ok: false, error: "Заказ не найден" });

      if (
        courierId &&
        r.courier_unit_id &&
        String(r.courier_unit_id) !== String(courierId)
      ) {
        return res.status(403).json({ ok: false, error: "Нет доступа к заказу" });
      }

      const dto = rowToMobileOrderDto(r);
      dto.items           = safeParseItemsJSON(r.items_json);
      dto.notes           = r.notes;
      dto.addressStreet   = r.address_street;
      dto.addressHouse    = r.address_house;
      dto.addressBuilding = r.address_building;
      dto.addressApartment = r.address_apartment;
      dto.addressFloor    = r.address_floor;
      dto.addressCode     = r.address_code;
      dto.amountSubtotal  = Number(r.amount_subtotal);
      dto.amountDiscount  = Number(r.amount_discount);

      return res.json({ ok: true, item: dto });
    } catch (e) {
      console.error("mobile orders GET /:id", e);
      res.status(500).json({ ok: false, error: "Ошибка сервера" });
    }
  });

  // ── PATCH /api/mobile-orders/:id/assign ─────────────────────────────────
  router.patch("/:id/assign", async (req, res) => {
    try {
      const ctx = await resolveCompanyContext(req, res);
      if (!ctx) return;

      const { companyId, user } = ctx;
      const orderId   = Number(req.params.id);
      const courierId = user.unitId || user.unit_id || user.userId || null;

      if (!courierId) {
        return res.status(400).json({ ok: false, error: "Не удалось определить ID курьера" });
      }

      const [[existing]] = await pool.query(
        "SELECT order_id, courier_unit_id FROM current_orders WHERE company_id=? AND order_id=?",
        [companyId, orderId]
      );
      if (!existing) return res.status(404).json({ ok: false, error: "Заказ не найден" });

      if (
        existing.courier_unit_id &&
        String(existing.courier_unit_id) !== String(courierId)
      ) {
        return res.status(409).json({ ok: false, error: "Заказ уже назначен другому курьеру" });
      }

      await pool.query(
        "UPDATE current_orders SET courier_unit_id=? WHERE company_id=? AND order_id=?",
        [courierId, companyId, orderId]
      );

      // Broadcast обновлённого заказа — всем клиентам компании (admin + courier)
      const updatedRow = await fetchOrderById(companyId, orderId);
      if (updatedRow) {
        broadcastToCompany(companyId, {
          type:      "order_updated",
          order:     rowToMobileOrderDto(updatedRow),
          companyId: companyId,
        });
      }

      res.json({ ok: true, message: "Заказ успешно принят" });
    } catch (e) {
      console.error("assign order error", e);
      res.status(500).json({ ok: false, error: "Ошибка сервера" });
    }
  });

  // ── PATCH /api/mobile-orders/:id/release ────────────────────────────────
  router.patch("/:id/release", async (req, res) => {
    try {
      const ctx = await resolveCompanyContext(req, res);
      if (!ctx) return;

      const { companyId, user } = ctx;
      const orderId   = Number(req.params.id);
      const courierId = user.unitId || user.unit_id || user.userId || null;

      const [[existing]] = await pool.query(
        "SELECT order_id, courier_unit_id FROM current_orders WHERE company_id=? AND order_id=?",
        [companyId, orderId]
      );
      if (!existing) return res.status(404).json({ ok: false, error: "Заказ не найден" });

      if (
        !existing.courier_unit_id ||
        String(existing.courier_unit_id) !== String(courierId)
      ) {
        return res.status(403).json({ ok: false, error: "Вы не можете отказаться от этого заказа" });
      }

      await pool.query(
        "UPDATE current_orders SET courier_unit_id=NULL WHERE company_id=? AND order_id=?",
        [companyId, orderId]
      );

      // Broadcast — заказ снова свободен
      const updatedRow = await fetchOrderById(companyId, orderId);
      if (updatedRow) {
        broadcastToCompany(companyId, {
          type:      "order_updated",
          order:     rowToMobileOrderDto(updatedRow),
          companyId: companyId,
        });
      }

      res.json({ ok: true, message: "Заказ успешно отказан" });
    } catch (e) {
      console.error("release order error", e);
      res.status(500).json({ ok: false, error: "Ошибка сервера" });
    }
  });

  return router;
}