import pool from "./db.js";

export async function getUser(req, res) {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "Нет токена" });

        // 1) Пользователь
        const [uRows] = await pool.query(
            `SELECT user_id, first_name, last_name, email, phone, role, company_id, created_at
             FROM users
             WHERE user_id = ?
                 LIMIT 1`,
            [userId]
        );
        if (uRows.length === 0) return res.status(404).json({ error: "Пользователь не найден" });

        const u = uRows[0];
        const user = {
            id: u.user_id,
            firstName: u.first_name,
            lastName: u.last_name,
            email: u.email,
            phone: u.phone,
            role: u.role,
            companyId: u.company_id,
            createdAt: u.created_at,
        };

        // 2) Компания (только если есть company_id)
        let company = null;
        if (u.company_id != null) {
            const [cRows] = await pool.query(
                `SELECT company_id,
                        company_owner_user_id,
                        company_owner_email,
                        company_name,
                        company_logo,
                        company_phone,
                        company_menu,
                        created_at
                 FROM companies
                 WHERE company_id = ?
                     LIMIT 1`,
                [u.company_id]
            );

            if (cRows.length) {
                const c = cRows[0];

                // Сформируем абсолютный URL, чтобы фронт не думал об origin/порте
                const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
                // в БД может лежать "BentoLogo.png" или "/companyLogo/BentoLogo.png"
                let logoPath = c.company_logo || null;
                if (logoPath) {
                    if (!logoPath.startsWith("/")) {
                        logoPath = `/companyLogo/${logoPath}`; // имя файла -> web-путь
                    }
                }
                const logoUrl = logoPath ? `${base}${logoPath}` : null;

                company = {
                    id: c.company_id,
                    name: c.company_name,
                    logoUrl,
                    phone: c.company_phone,
                    ownerUserId: c.company_owner_user_id,
                    ownerEmail: c.company_owner_email,
                    menuId: c.company_menu,
                    createdAt: c.created_at,
                };
            }
        }

        return res.json({ ok: true, user, company });
    } catch (err) {
        console.error("getUser error:", err);
        return res.status(500).json({ error: "Ошибка сервера" });
    }
}
