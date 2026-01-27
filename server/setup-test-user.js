// Temporary script to set up test user and run migration
import bcrypt from "bcrypt";
import pool from "./db.js";
import "dotenv/config";

async function setup() {
    try {
        console.log("Running 2FA migration...");

        // Check if columns already exist
        const [columns] = await pool.query(
            "SHOW COLUMNS FROM users LIKE 'totp_secret'"
        );

        if (columns.length === 0) {
            await pool.query(
                "ALTER TABLE users ADD COLUMN totp_secret VARCHAR(64) NULL AFTER password"
            );
            console.log("Added totp_secret column");

            await pool.query(
                "ALTER TABLE users ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT FALSE AFTER totp_secret"
            );
            console.log("Added totp_enabled column");
        } else {
            console.log("2FA columns already exist, skipping migration");
        }

        // Check if test user exists
        const [existingUser] = await pool.query(
            "SELECT user_id FROM users WHERE email = ?",
            ["test@demo.com"]
        );

        if (existingUser.length > 0) {
            console.log("Test user already exists");
        } else {
            // First, ensure we have a company
            const [companies] = await pool.query("SELECT company_id FROM companies LIMIT 1");

            let companyId;
            if (companies.length === 0) {
                // Create a test company
                const [companyResult] = await pool.query(
                    `INSERT INTO companies (name, phone, created_at, updated_at)
                     VALUES ('Demo Company', '+37120000000', NOW(), NOW())`
                );
                companyId = companyResult.insertId;
                console.log("Created test company with ID:", companyId);
            } else {
                companyId = companies[0].company_id;
                console.log("Using existing company ID:", companyId);
            }

            // Create test user with hashed password
            const password = "test123";
            const passwordHash = await bcrypt.hash(password, 10);

            const [result] = await pool.query(
                `INSERT INTO users
                    (first_name, last_name, email, phone, password, role, company_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
                ["Test", "User", "test@demo.com", "+37120000001", passwordHash, "owner", companyId]
            );

            console.log("Created test user with ID:", result.insertId);
        }

        console.log("\n========================================");
        console.log("TEST USER CREDENTIALS:");
        console.log("========================================");
        console.log("Email:    test@demo.com");
        console.log("Password: test123");
        console.log("Role:     owner");
        console.log("========================================\n");

        process.exit(0);
    } catch (err) {
        console.error("Setup error:", err);
        process.exit(1);
    }
}

setup();
