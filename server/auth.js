import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import pool from "./db.js";
import {
    generateSecret,
    generateOTPAuthURI,
    verifyTOTP,
} from "./totp.js";

const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key";
const TEMP_TOKEN_SECRET = process.env.TEMP_TOKEN_SECRET || "temp_2fa_secret_key";

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
            `SELECT user_id, password, role, company_id, totp_enabled
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

        // Check if 2FA is enabled for this user
        if (user.totp_enabled) {
            // Generate a temporary token for 2FA verification
            const tempToken = jwt.sign(
                {
                    userId: user.user_id,
                    role: user.role,
                    companyId: user.company_id,
                    purpose: "2fa_verification"
                },
                TEMP_TOKEN_SECRET,
                { expiresIn: "5m" } // Short expiry for 2FA verification
            );

            return res.json({
                ok: true,
                requires2FA: true,
                tempToken
            });
        }

        // No 2FA enabled, issue the full JWT token
        const token = jwt.sign(
            { userId: user.user_id, role: user.role, companyId: user.company_id },
            JWT_SECRET,
            { expiresIn: "30m" }
        );

        return res.json({ ok: true, token });
    } catch (err) {
        console.error("Ошибка логина:", err);
        res.status(500).json({ error: "Ошибка сервера" });
    }
}

export async function courierlogin(req, res) {
    try {
        const { unit_email, unit_password } = req.body; // здесь может прийти email ИЛИ телефон
        if (!unit_email || !unit_password) {
            return res.status(400).json({ error: "Email и пароль обязательны" });
        }

        const identifier = String(unit_email).trim();

        const [rows] = await pool.query(
            `SELECT unit_id, unit_nickname, unit_role, company_id, unit_password_hash, is_active
         FROM company_units
        WHERE unit_email = ? OR unit_phone = ?
        LIMIT 1`,
            [identifier, identifier]
        );

        if (rows.length === 0) {
            return res.status(401).json({ error: "Неверный email или пароль" });
        }

        const user = rows[0];

        if (!user.is_active) {
            return res.status(403).json({ error: "Учётная запись деактивирована" });
        }

        const valid = await bcrypt.compare(unit_password, user.unit_password_hash);
        if (!valid) {
            return res.status(401).json({ error: "Неверный email или пароль" });
        }

        const token = jwt.sign(
            {
                userId: user.unit_id,
                role: user.unit_role,
                companyId: user.company_id,
                unitNickname: typeof user.unit_nickname === 'string' ? user.unit_nickname : null
            },
            JWT_SECRET,
            { expiresIn: "30m" }
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

// --- 2FA: Setup ---
// Generate a new TOTP secret for the user (does not enable 2FA yet)
export async function setup2FA(req, res) {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(401).json({ error: "Не авторизован" });
        }

        // Get user email for the otpauth URI
        const [rows] = await pool.query(
            "SELECT email, totp_enabled FROM users WHERE user_id = ? LIMIT 1",
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Пользователь не найден" });
        }

        const user = rows[0];

        // Check if 2FA is already enabled
        if (user.totp_enabled) {
            return res.status(400).json({ error: "2FA уже включена. Отключите её перед повторной настройкой" });
        }

        // Generate a new TOTP secret
        const secret = generateSecret();

        // Store the secret in the database (not enabled yet)
        await pool.query(
            "UPDATE users SET totp_secret = ? WHERE user_id = ?",
            [secret, userId]
        );

        // Generate the otpauth URI for QR code
        const otpauthUri = generateOTPAuthURI(user.email, secret);

        return res.json({
            ok: true,
            secret,
            otpauthUri
        });
    } catch (err) {
        console.error("Ошибка настройки 2FA:", err);
        res.status(500).json({ error: "Ошибка сервера" });
    }
}

// --- 2FA: Verify Setup ---
// Verify the OTP code and enable 2FA
export async function verifySetup2FA(req, res) {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(401).json({ error: "Не авторизован" });
        }

        const { code } = req.body;
        if (!code) {
            return res.status(400).json({ error: "Код обязателен" });
        }

        // Get the stored secret
        const [rows] = await pool.query(
            "SELECT totp_secret, totp_enabled FROM users WHERE user_id = ? LIMIT 1",
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Пользователь не найден" });
        }

        const user = rows[0];

        if (!user.totp_secret) {
            return res.status(400).json({ error: "Сначала выполните настройку 2FA" });
        }

        if (user.totp_enabled) {
            return res.status(400).json({ error: "2FA уже включена" });
        }

        // Verify the code
        const isValid = verifyTOTP(user.totp_secret, code);
        if (!isValid) {
            return res.status(400).json({ error: "Неверный код" });
        }

        // Enable 2FA
        await pool.query(
            "UPDATE users SET totp_enabled = TRUE WHERE user_id = ?",
            [userId]
        );

        return res.json({ ok: true, message: "2FA успешно включена" });
    } catch (err) {
        console.error("Ошибка верификации 2FA:", err);
        res.status(500).json({ error: "Ошибка сервера" });
    }
}

// --- 2FA: Disable ---
// Verify OTP and disable 2FA
export async function disable2FA(req, res) {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(401).json({ error: "Не авторизован" });
        }

        const { code } = req.body;
        if (!code) {
            return res.status(400).json({ error: "Код обязателен" });
        }

        // Get the stored secret
        const [rows] = await pool.query(
            "SELECT totp_secret, totp_enabled FROM users WHERE user_id = ? LIMIT 1",
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Пользователь не найден" });
        }

        const user = rows[0];

        if (!user.totp_enabled) {
            return res.status(400).json({ error: "2FA не включена" });
        }

        // Verify the code before disabling
        const isValid = verifyTOTP(user.totp_secret, code);
        if (!isValid) {
            return res.status(400).json({ error: "Неверный код" });
        }

        // Disable 2FA and clear the secret
        await pool.query(
            "UPDATE users SET totp_enabled = FALSE, totp_secret = NULL WHERE user_id = ?",
            [userId]
        );

        return res.json({ ok: true, message: "2FA успешно отключена" });
    } catch (err) {
        console.error("Ошибка отключения 2FA:", err);
        res.status(500).json({ error: "Ошибка сервера" });
    }
}

// --- 2FA: Status ---
// Get the current 2FA status for the user
export async function get2FAStatus(req, res) {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(401).json({ error: "Не авторизован" });
        }

        const [rows] = await pool.query(
            "SELECT totp_enabled FROM users WHERE user_id = ? LIMIT 1",
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Пользователь не найден" });
        }

        return res.json({
            ok: true,
            enabled: Boolean(rows[0].totp_enabled)
        });
    } catch (err) {
        console.error("Ошибка получения статуса 2FA:", err);
        res.status(500).json({ error: "Ошибка сервера" });
    }
}

// --- 2FA: Verify Login ---
// Verify the OTP code during login and issue the real JWT
export async function verifyLogin2FA(req, res) {
    try {
        const { tempToken, code } = req.body;

        if (!tempToken || !code) {
            return res.status(400).json({ error: "Токен и код обязательны" });
        }

        // Verify the temporary token
        let decoded;
        try {
            decoded = jwt.verify(tempToken, TEMP_TOKEN_SECRET);
        } catch (err) {
            return res.status(401).json({ error: "Невалидный или просроченный временный токен" });
        }

        // Check that this is a 2FA verification token
        if (decoded.purpose !== "2fa_verification") {
            return res.status(401).json({ error: "Невалидный токен" });
        }

        const userId = decoded.userId;

        // Get the stored secret
        const [rows] = await pool.query(
            "SELECT totp_secret, totp_enabled FROM users WHERE user_id = ? LIMIT 1",
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Пользователь не найден" });
        }

        const user = rows[0];

        if (!user.totp_enabled || !user.totp_secret) {
            return res.status(400).json({ error: "2FA не настроена для этого пользователя" });
        }

        // Verify the code
        const isValid = verifyTOTP(user.totp_secret, code);
        if (!isValid) {
            return res.status(401).json({ error: "Неверный код" });
        }

        // Issue the real JWT token
        const token = jwt.sign(
            { userId: decoded.userId, role: decoded.role, companyId: decoded.companyId },
            JWT_SECRET,
            { expiresIn: "30m" }
        );

        return res.json({ ok: true, token });
    } catch (err) {
        console.error("Ошибка верификации 2FA при логине:", err);
        res.status(500).json({ error: "Ошибка сервера" });
    }
}

