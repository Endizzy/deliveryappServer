// Start server with SQLite for local development/testing
import bcrypt from "bcrypt";
import { createSqlitePool } from "./db-sqlite.js";
import { createSchema } from "./test/setup.js";

// Set environment for SQLite
process.env.DB_ADAPTER = "sqlite";
process.env.SQLITE_FILE = "./dev.db";
process.env.JWT_SECRET = "dev_jwt_secret_key_12345";
process.env.PORT = "4000";

// Create and initialize database
const pool = createSqlitePool("./dev.db");
createSchema(pool);

console.log("SQLite database initialized");

// Seed test data if empty
const [users] = await pool.query("SELECT COUNT(*) as count FROM users");
if (users[0].count === 0) {
    // Create test company
    await pool.query(
        `INSERT INTO companies (company_id, company_name, company_phone)
         VALUES (1, 'Demo Delivery', '+37120000000')`
    );
    console.log("Created test company");

    // Create test user with hashed password
    const password = "test123";
    const passwordHash = await bcrypt.hash(password, 10);

    await pool.query(
        `INSERT INTO users (user_id, first_name, last_name, email, phone, password, role, company_id)
         VALUES (1, 'Test', 'User', 'test@demo.com', '+37120000001', ?, 'owner', 1)`,
        [passwordHash]
    );
    console.log("Created test user");

    // Create a test courier
    const courierPasswordHash = await bcrypt.hash("courier123", 10);
    await pool.query(
        `INSERT INTO company_units (unit_id, company_id, unit_nickname, unit_email, unit_role, unit_password_hash, is_active)
         VALUES (1, 1, 'Courier One', 'courier@demo.com', 'courier', ?, 1)`,
        [courierPasswordHash]
    );
    console.log("Created test courier");
}

console.log("\n========================================");
console.log("TEST CREDENTIALS:");
console.log("========================================");
console.log("Owner Login:");
console.log("  Email:    test@demo.com");
console.log("  Password: test123");
console.log("----------------------------------------");
console.log("Courier Login:");
console.log("  Email:    courier@demo.com");
console.log("  Password: courier123");
console.log("========================================\n");

// Now start the actual server
console.log("Starting server...\n");
await import("./index.js");
