
import pool from "./db.js";

export async function getUser(req, res) {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(401).json({ error: "Нет токена" });
        }

        const [rows] = await pool.query(
            `SELECT user_id, first_name, last_name, email, phone, role, company_id, created_at
         FROM users
        WHERE user_id = ?
        LIMIT 1`,
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Пользователь не найден" });
        }

        const u = rows[0];
        return res.json({
            ok: true,
            user: {
                id: u.user_id,
                firstName: u.first_name,
                lastName: u.last_name,
                email: u.email,
                phone: u.phone,
                role: u.role,
                companyId: u.company_id,
                createdAt: u.created_at,
            },
        });
    } catch (err) {
        console.error("getUser error:", err);
        return res.status(500).json({ error: "Ошибка сервера" });
    }
}
