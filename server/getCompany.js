import pool from "./db.js";

export async function getCompany(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: "Нет токена" });

    // 1) узнаём company_id пользователя
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
      return res.json({ ok: true, company: null }); // или 404 — как тебе удобнее
    }

    // 2) берём только нужные поля компании
    const [cRows] = await pool.query(
      `SELECT company_id, company_name, company_logo
       FROM companies
       WHERE company_id = ?
       LIMIT 1`,
      [companyId]
    );

    if (!cRows.length) return res.status(404).json({ error: "Компания не найдена" });

    const c = cRows[0];

    // абсолютный URL для лого
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    let logoPath = c.company_logo || null;
    if (logoPath && !logoPath.startsWith("/")) {
      logoPath = `/companyLogo/${logoPath}`;
    }
    const logoUrl = logoPath ? `${base}${logoPath}` : null;

    return res.json({
      ok: true,
      company: {
        id: c.company_id,
        name: c.company_name,
        logoUrl,
      },
    });
  } catch (err) {
    console.error("getCompany error:", err);
    return res.status(500).json({ error: "Ошибка сервера" });
  }
}
