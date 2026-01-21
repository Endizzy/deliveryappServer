// server/db-sqlite.js
// SQLite adapter with mysql2-compatible API for testing
import Database from "better-sqlite3";

/**
 * Converts MySQL query syntax to SQLite
 */
function convertQuery(sql) {
    return sql
        // Remove FOR UPDATE (SQLite has different locking)
        .replace(/\s+FOR\s+UPDATE/gi, "")
        // NOW() -> datetime('now')
        .replace(/\bNOW\(\)/gi, "datetime('now')");
}

/**
 * Creates a mysql2-compatible pool wrapping better-sqlite3
 */
export function createSqlitePool(filename = ":memory:") {
    const db = Database(filename);
    db.pragma("journal_mode = WAL");

    const pool = {
        _db: db,

        async query(sql, params = []) {
            const converted = convertQuery(sql);
            const stmt = db.prepare(converted);

            // Determine if it's a SELECT or mutation
            const isSelect = /^\s*SELECT/i.test(converted);

            if (isSelect) {
                const rows = stmt.all(...params);
                return [rows, []]; // [rows, fields] like mysql2
            } else {
                const result = stmt.run(...params);
                return [
                    {
                        insertId: result.lastInsertRowid,
                        affectedRows: result.changes,
                    },
                    [],
                ];
            }
        },

        async getConnection() {
            // SQLite is single-connection, so we simulate a connection object
            let inTransaction = false;

            return {
                async query(sql, params = []) {
                    return pool.query(sql, params);
                },

                async beginTransaction() {
                    if (!inTransaction) {
                        db.exec("BEGIN IMMEDIATE");
                        inTransaction = true;
                    }
                },

                async commit() {
                    if (inTransaction) {
                        db.exec("COMMIT");
                        inTransaction = false;
                    }
                },

                async rollback() {
                    if (inTransaction) {
                        db.exec("ROLLBACK");
                        inTransaction = false;
                    }
                },

                release() {
                    // No-op for SQLite (single connection)
                    // But ensure we rollback any uncommitted transaction
                    if (inTransaction) {
                        db.exec("ROLLBACK");
                        inTransaction = false;
                    }
                },
            };
        },

        async end() {
            db.close();
        },
    };

    return pool;
}

export default createSqlitePool;
