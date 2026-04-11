import pool from "./db.js";

export async function getReport(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: "Нет токена" });

    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate are required" });
    }

    // 1) Find the user's company_id
    const [uRows] = await pool.query(
      `SELECT company_id
       FROM users
       WHERE user_id = ?
       LIMIT 1`,
      [userId]
    );

    if (!uRows.length) return res.status(404).json({ error: "Пользователь не найден" });

    const companyId = uRows[0].company_id;

    if (companyId == null) {
      return res.json([]);
    }

    // 2) Calculate per-courier stats, plus a catch-all row for unassigned orders
    const [reportRows] = await pool.query(
      `WITH OrderStats AS (
          SELECT
              co.courier_unit_id,
              co.order_id AS order_id,
              co.amount_total,
              co.payment_method,
              COALESCE(SUM(jt.quantity), 0) AS items_count
          FROM current_orders co
          LEFT JOIN JSON_TABLE(
              co.items_json,
              '$[*]' COLUMNS (quantity INT PATH '$.quantity')
          ) AS jt ON TRUE
          WHERE co.company_id = ?
            AND DATE(co.created_at) BETWEEN ? AND ?
            AND co.status = 'completed'
          GROUP BY co.order_id
      )
      SELECT
          cu.unit_id AS unit_id,
          cu.unit_nickname AS unit_nickname,
          cu.company_id,
          COUNT(os.order_id) AS total_orders,
          COALESCE(SUM(os.amount_total), 0) AS total_sum,
          COALESCE(SUM(CASE WHEN os.payment_method = 'cash' THEN os.amount_total ELSE 0 END), 0) AS total_cash_sum,
          COALESCE(SUM(CASE WHEN os.payment_method = 'card' THEN os.amount_total ELSE 0 END), 0) AS total_card_sum,
          COALESCE(SUM(os.items_count), 0) AS total_items
      FROM
          company_units cu
      LEFT JOIN
          OrderStats os ON cu.unit_id = os.courier_unit_id
      WHERE
          cu.company_id = ?
          AND cu.unit_role = 'courier'
      GROUP BY
          cu.unit_id

      UNION ALL

      SELECT
          NULL AS unit_id,
          'Unassigned' AS unit_nickname,
          ? AS company_id,
          COUNT(os.order_id) AS total_orders,
          COALESCE(SUM(os.amount_total), 0) AS total_sum,
          COALESCE(SUM(CASE WHEN os.payment_method = 'cash' THEN os.amount_total ELSE 0 END), 0) AS total_cash_sum,
          COALESCE(SUM(CASE WHEN os.payment_method = 'card' THEN os.amount_total ELSE 0 END), 0) AS total_card_sum,
          COALESCE(SUM(os.items_count), 0) AS total_items
      FROM OrderStats os
      WHERE os.courier_unit_id IS NULL
         OR os.courier_unit_id NOT IN (
             SELECT unit_id FROM company_units WHERE company_id = ? AND unit_role = 'courier'
         )
      HAVING COUNT(os.order_id) > 0`,
      [companyId, startDate, endDate, companyId, companyId, companyId]
    );

    return res.json(reportRows);

  } catch (err) {
    console.error("getReport error:", err);
    return res.status(500).json({ error: "Ошибка сервера" });
  }
}
