import express from "express";
import pool from "./db.js";
import { resolveCompanyContext } from "./currentOrder.js";

function rowToMobileOrderDto(r) {
  // address: без домофона/кода (код уходит отдельно addressCode)
  const addr = [
    r.address_street,
    r.address_house && `д.${r.address_house}`,
    r.address_building && `к.${r.address_building}`,
    r.address_apartment && `кв.${r.address_apartment}`,
    r.address_floor && `эт.${r.address_floor}`,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    id: r.order_id,
    orderNo: r.order_no,
    orderSeq: r.order_seq ?? null,
    orderDay: r.order_seq_date ?? null,
    orderType: r.order_type,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    scheduledAt: r.scheduled_at,

    amountTotal: Number(r.amount_total),
    deliveryFee: Number(r.delivery_fee || 0),
    paymentMethod: r.payment_method,

    customer: r.customer_name,
    phone: r.customer_phone,

    address: addr,
    outlet: r.pickup_nickname || "",
    courierId: r.courier_unit_id,
  };
}

function safeParseItemsJSON(v) {
  try {
    if (v == null) return [];
    if (Array.isArray(v)) return v;

    if (typeof v === "string") {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    }

    if (Buffer.isBuffer(v)) {
      const parsed = JSON.parse(v.toString("utf8"));
      return Array.isArray(parsed) ? parsed : [];
    }

    // если вдруг из драйвера прилетит уже объект/массив
    if (typeof v === "object") {
      return Array.isArray(v) ? v : [];
    }

    return [];
  } catch {
    return [];
  }
}

const router = express.Router();

// Factory function: returns router with broadcastToAdmins injected
export default function createMobileOrdersRouter({ broadcastToAdmins } = {}) {
  const router = express.Router();

// GET /api/mobile-orders?tab=active|all|my
router.get("/", async (req, res) => {
  try {
    const ctx = await resolveCompanyContext(req, res);
    if (!ctx) return;

    const { companyId, user } = ctx;
    const tab = (req.query.tab || "active").toLowerCase();
    // For couriers, unit_id is stored in userId field of JWT
    const courierId = user.unitId || user.unit_id || user.userId || null;
    
    console.log(`[mobile-orders] tab=${tab}, courierId=${courierId}, user=`, user);

    const where = ["co.company_id=?"];
    const params = [companyId];

    // Exclude cancelled orders for all tabs
    where.push("co.status != 'cancelled'");

    if (tab === "active") {
      // Активные заказы WITHOUT courier_unit_id assigned (only unassigned orders)
      where.push("co.status IN ('new','ready','enroute')");
      where.push("co.courier_unit_id IS NULL");
    } else if (tab === "my") {
      // Заказы assigned to current courier (all statuses except cancelled)
      if (!courierId) {
        return res.json({ ok: true, items: [] });
      }
      where.push("co.courier_unit_id=?");
      params.push(courierId);
    } else if (tab === "all") {
      // All unassigned orders (same as "active" but without status filter)
      where.push("co.courier_unit_id IS NULL");
    }

    const sql = `
      SELECT co.*, cu2.unit_nickname AS pickup_nickname
      FROM current_orders co
      LEFT JOIN company_units cu2 ON cu2.unit_id = co.pickup_unit_id
      WHERE ${where.join(" AND ")}
      ORDER BY co.created_at DESC, co.order_id DESC
      LIMIT 100`;

    const [rows] = await pool.query(sql, params);
    res.json({ ok: true, items: rows.map(rowToMobileOrderDto) });
  } catch (e) {
    console.error("mobile orders", e);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// GET /api/mobile-orders/:id
router.get("/:id", async (req, res) => {
  try {
    const ctx = await resolveCompanyContext(req, res);
    if (!ctx) return;

    const { companyId, user } = ctx;
    const id = Number(req.params.id);
    // For couriers, unit_id is stored in userId field of JWT
    const courierId = user.unitId || user.unit_id || user.userId || null;

    const sql = `
      SELECT co.*, cu2.unit_nickname AS pickup_nickname
      FROM current_orders co
      LEFT JOIN company_units cu2 ON cu2.unit_id = co.pickup_unit_id
      WHERE co.company_id=? AND co.order_id=?
      LIMIT 1`;

    const [rows] = await pool.query(sql, [companyId, id]);
    if (!rows.length) {
      return res.status(404).json({ ok: false, error: "Заказ не найден" });
    }

    const r = rows[0];

    // (опционально: можно проверить, что заказ назначен этому курьеру)
    if (courierId && r.courier_unit_id && String(r.courier_unit_id) !== String(courierId)) {
      return res.status(403).json({ ok: false, error: "Нет доступа к заказу" });
    }

    const dto = rowToMobileOrderDto(r);

    dto.items = safeParseItemsJSON(r.items_json);
    dto.notes = r.notes;

    dto.addressStreet = r.address_street;
    dto.addressHouse = r.address_house;
    dto.addressBuilding = r.address_building;
    dto.addressApartment = r.address_apartment;
    dto.addressFloor = r.address_floor;
    dto.addressCode = r.address_code;

    dto.amountSubtotal = Number(r.amount_subtotal);
    dto.amountDiscount = Number(r.amount_discount);
    dto.deliveryFee = Number(r.delivery_fee || 0);

    return res.json({ ok: true, item: dto });
  } catch (e) {
    console.error("mobile order details", e);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// PATCH /api/mobile-orders/:id/assign
// Assign order to current courier
router.patch("/:id/assign", async (req, res) => {
  try {
    const ctx = await resolveCompanyContext(req, res);
    if (!ctx) return;

    const { companyId, user } = ctx;
    const orderId = Number(req.params.id);
    // For couriers, unit_id is stored in userId field of JWT
    const courierId = user.unitId || user.unit_id || user.userId || null;

    if (!courierId) {
      return res.status(400).json({ ok: false, error: "Не удалось определить ID курьера" });
    }

    // Check if order exists and belongs to company
    const [checkRows] = await pool.query(
      "SELECT order_id, courier_unit_id FROM current_orders WHERE company_id=? AND order_id=?",
      [companyId, orderId]
    );

    if (!checkRows.length) {
      return res.status(404).json({ ok: false, error: "Заказ не найден" });
    }

    const order = checkRows[0];

    // Check if order is already assigned to someone else
    if (order.courier_unit_id && String(order.courier_unit_id) !== String(courierId)) {
      return res.status(409).json({ ok: false, error: "Заказ уже назначен другому курьеру" });
    }

    // Assign order to current courier
    await pool.query(
      "UPDATE current_orders SET courier_unit_id=? WHERE company_id=? AND order_id=?",
      [courierId, companyId, orderId]
    );

    // Broadcast to all admins that order was assigned
    if (typeof broadcastToAdmins === "function") {
      broadcastToAdmins({
        type: "order_assigned",
        companyId,
        orderId,
        courierId: String(courierId),
        timestamp: new Date().toISOString(),
      });
    }

    res.json({ ok: true, message: "Заказ успешно принят" });
  } catch (e) {
    console.error("assign order error", e);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// PATCH /api/mobile-orders/:id/release
// Release order from current courier
router.patch("/:id/release", async (req, res) => {
  try {
    const ctx = await resolveCompanyContext(req, res);
    if (!ctx) return;

    const { companyId, user } = ctx;
    const orderId = Number(req.params.id);
    // For couriers, unit_id is stored in userId field of JWT
    const courierId = user.unitId || user.unit_id || user.userId || null;

    // Check if order exists and belongs to company
    const [checkRows] = await pool.query(
      "SELECT order_id, courier_unit_id FROM current_orders WHERE company_id=? AND order_id=?",
      [companyId, orderId]
    );

    if (!checkRows.length) {
      return res.status(404).json({ ok: false, error: "Заказ не найден" });
    }

    const order = checkRows[0];

    // Check if order is assigned to current courier
    if (!order.courier_unit_id || String(order.courier_unit_id) !== String(courierId)) {
      return res.status(403).json({ ok: false, error: "Вы не можете отказаться от этого заказа" });
    }

    // Release order (set courier_unit_id to NULL)
    await pool.query(
      "UPDATE current_orders SET courier_unit_id=NULL WHERE company_id=? AND order_id=?",
      [companyId, orderId]
    );

    // Broadcast to all admins that order was released
    if (typeof broadcastToAdmins === "function") {
      broadcastToAdmins({
        type: "order_released",
        companyId,
        orderId,
        courierId: String(courierId),
        timestamp: new Date().toISOString(),
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
