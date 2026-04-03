import pool from "./db.js";

// Нормализация телефона к виду +371XXXXXXXX
function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");

  if (!digits) return "";

  if (digits.startsWith("371")) return `+${digits}`;
  if (digits.length === 8) return `+371${digits}`;

  return String(phone || "").replace(/\s/g, "");
}

export async function getCustomerAddressByPhone(req, res) {
  try {
    const phoneRaw = req.query.phone;
    const phone = normalizePhone(phoneRaw);

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "Phone is required",
      });
    }

    const sql = `
      SELECT
        customer_name,
        customer_phone,
        address_street,
        address_house,
        address_building,
        address_apartment,
        address_floor,
        address_code,
        created_at,
        order_id
      FROM current_orders
      WHERE customer_phone = ?
        AND (
          COALESCE(address_street, '') <> '' OR
          COALESCE(address_house, '') <> '' OR
          COALESCE(address_building, '') <> '' OR
          COALESCE(address_apartment, '') <> '' OR
          COALESCE(address_floor, '') <> '' OR
          COALESCE(address_code, '') <> ''
        )
      ORDER BY created_at DESC, order_id DESC
      LIMIT 1
    `;

    const [rows] = await pool.execute(sql, [phone]);

    if (!rows.length) {
      return res.json({
        ok: true,
        found: false,
      });
    }

    const row = rows[0];

    return res.json({
      ok: true,
      found: true,
      address: {
        street: row.address_street || "",
        house: row.address_house || "",
        apart: row.address_apartment || "",
        building: row.address_building || "",
        floor: row.address_floor || "",
        code: row.address_code || "",
      },
      meta: {
        customerName: row.customer_name || "",
        phone: row.customer_phone || phone,
        lastOrderAt: row.created_at || null,
      },
    });
  } catch (error) {
    console.error("getCustomerAddressByPhone error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to lookup customer address",
    });
  }
}