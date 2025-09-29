// server/auth.js
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import pool from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key";

// --- Регистрация ---
export async function register(req, res) {
    try {
        const { firstName, lastName, email, phone, password } = req.body;

        if (!firstName || !lastName || !email || !phone || !password) {
            return res.status(400).json({ error: "Все поля обязательны" });
        }

        // Проверка на уникальность email и телефона
        const [rows] = await pool.query(
            "SELECT user_id FROM users WHERE email = ? OR phone = ? LIMIT 1",
            [email, phone]
        );
        if (rows.length > 0) {
            return res.status(400).json({ error: "Email или телефон уже используется" });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        // Создаём пользователя с дефолтной ролью client
        const [result] = await pool.query(
            `INSERT INTO users 
                (first_name, last_name, email, phone, password, role, company_id, created_at, updated_at) 
             VALUES (?, ?, ?, ?, ?, 'client', DEFAULT, NOW(), NOW())`,
            [firstName, lastName, email, phone, passwordHash]
        );

        return res.json({ ok: true, message: "Регистрация успешна", userId: result.insertId });
    } catch (err) {
        console.error("Ошибка регистрации:", err);
        res.status(500).json({ error: "Ошибка сервера" });
    }
}

// --- Логин ---
export async function login(req, res) {
    try {
        const { email, password } = req.body; // здесь может прийти email ИЛИ телефон
        if (!email || !password) {
            return res.status(400).json({ error: "Email и пароль обязательны" });
        }

        const identifier = String(email).trim();

        const [rows] = await pool.query(
            `SELECT user_id, password, role
         FROM users
        WHERE email = ? OR phone = ?
        LIMIT 1`,
            [identifier, identifier]
        );

        if (rows.length === 0) {
            return res.status(401).json({ error: "Неверный email или пароль" });
        }

        const user = rows[0];
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            return res.status(401).json({ error: "Неверный email или пароль" });
        }

        const token = jwt.sign(
            { userId: user.user_id, role: user.role },
            JWT_SECRET,
            { expiresIn: "15m" }
        );

        return res.json({ ok: true, token });
    } catch (err) {
        console.error("Ошибка логина:", err);
        res.status(500).json({ error: "Ошибка сервера" });
    }
}


// --- Middleware для проверки токена ---
export function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Нет токена" });

    const token = authHeader.split(" ")[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // { userId, role }
        next();
    } catch (err) {
        return res.status(401).json({ error: "Невалидный или просроченный токен" });
    }
}

export function roleMiddleware(roles = []) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: "Не авторизован" });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: "Доступ запрещён" });
        }
        next();
    };
}

