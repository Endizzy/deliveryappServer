// server/db.js
let pool;

if (process.env.DB_ADAPTER === "sqlite") {
    // Use SQLite adapter for testing
    const { createSqlitePool } = await import("./db-sqlite.js");
    pool = createSqlitePool(process.env.SQLITE_FILE || ":memory:");
} else {
    // Use MySQL for production
    const mysql = await import("mysql2/promise");
    pool = mysql.default.createPool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        connectionLimit: 10,
    });
}

export default pool;
