// server/test/setup.js
// Test utilities for SQLite-based testing

// Set environment before any imports
process.env.DB_ADAPTER = "sqlite";

import { createSqlitePool } from "../db-sqlite.js";

/**
 * Creates the database schema for testing
 */
export function createSchema(pool) {
    const db = pool._db;

    db.exec(`
        CREATE TABLE IF NOT EXISTS companies (
            company_id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_owner_user_id INTEGER,
            company_owner_email TEXT,
            company_name TEXT,
            company_logo TEXT,
            company_phone TEXT,
            company_menu TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY AUTOINCREMENT,
            first_name TEXT,
            last_name TEXT,
            email TEXT UNIQUE,
            phone TEXT,
            password TEXT,
            totp_secret TEXT,
            totp_enabled INTEGER DEFAULT 0,
            role TEXT DEFAULT 'client',
            company_id INTEGER,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS company_units (
            unit_id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            unit_nickname TEXT,
            unit_phone TEXT,
            unit_email TEXT UNIQUE,
            unit_role TEXT,
            unit_password_hash TEXT,
            is_active INTEGER DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS current_orders (
            order_id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            order_no TEXT,
            order_seq INTEGER,
            order_seq_date TEXT,
            order_type TEXT DEFAULT 'active',
            status TEXT DEFAULT 'new',
            scheduled_at TEXT,
            courier_unit_id INTEGER,
            pickup_unit_id INTEGER,
            dispatcher_unit_id INTEGER,
            payment_method TEXT,
            customer_name TEXT,
            customer_phone TEXT,
            address_street TEXT,
            address_house TEXT,
            address_building TEXT,
            address_apartment TEXT,
            address_floor TEXT,
            address_code TEXT,
            notes TEXT,
            items_json TEXT,
            amount_subtotal REAL DEFAULT 0,
            amount_discount REAL DEFAULT 0,
            amount_total REAL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS menu (
            item_id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            item_name TEXT,
            item_category TEXT,
            item_price REAL,
            item_discount_percent REAL DEFAULT 0,
            is_active INTEGER DEFAULT 1
        );
    `);
}

/**
 * Seeds basic test data
 */
export async function seedTestData(pool) {
    // Create two test companies
    await pool.query(
        `INSERT INTO companies (company_id, company_name) VALUES (1, 'Test Company A')`
    );
    await pool.query(
        `INSERT INTO companies (company_id, company_name) VALUES (2, 'Test Company B')`
    );

    // Create test users
    await pool.query(
        `INSERT INTO users (user_id, email, password, role, company_id)
         VALUES (1, 'admin@test.com', 'hash', 'admin', 1)`
    );
    await pool.query(
        `INSERT INTO users (user_id, email, password, role, company_id)
         VALUES (2, 'admin@testb.com', 'hash', 'admin', 2)`
    );

    // Create test couriers
    await pool.query(
        `INSERT INTO company_units (unit_id, company_id, unit_nickname, unit_role, is_active)
         VALUES (1, 1, 'Courier 1', 'courier', 1)`
    );
}

/**
 * Clears all test data
 */
export async function clearData(pool) {
    await pool.query(`DELETE FROM current_orders`);
    await pool.query(`DELETE FROM menu`);
    await pool.query(`DELETE FROM company_units`);
    await pool.query(`DELETE FROM users`);
    await pool.query(`DELETE FROM companies`);
}

/**
 * Date mocking utilities
 */
const RealDate = Date;

export function mockDate(isoString) {
    const fixedTime = new RealDate(isoString).getTime();

    global.Date = class MockDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) {
                super(fixedTime);
            } else {
                super(...args);
            }
        }

        static now() {
            return fixedTime;
        }

        static parse(str) {
            return RealDate.parse(str);
        }

        static UTC(...args) {
            return RealDate.UTC(...args);
        }
    };
}

export function restoreDate() {
    global.Date = RealDate;
}

/**
 * Creates a fresh test pool with schema
 */
export function createTestPool() {
    const pool = createSqlitePool(":memory:");
    createSchema(pool);
    return pool;
}
