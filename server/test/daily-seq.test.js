// server/test/daily-seq.test.js
// Tests for daily order sequence allocation

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert";

// Set up test environment BEFORE importing modules that use db
process.env.DB_ADAPTER = "sqlite";

import {
    createTestPool,
    seedTestData,
    mockDate,
    restoreDate,
} from "./setup.js";
import { deriveOrderSeqDate, allocateDailySeq } from "../currentOrder.js";

// We need to replace the pool used by currentOrder.js
// For unit tests, we'll test the functions directly with our test pool

describe("deriveOrderSeqDate", () => {
    beforeEach(() => {
        restoreDate();
    });

    after(() => {
        restoreDate();
    });

    it("returns current date for active orders", () => {
        mockDate("2024-09-20T10:00:00Z");

        const result = deriveOrderSeqDate("active", null);
        assert.strictEqual(result, "2024-09-20");
    });

    it("returns current date for preorders without scheduled date", () => {
        mockDate("2024-09-20T10:00:00Z");

        const result = deriveOrderSeqDate("preorder", null);
        assert.strictEqual(result, "2024-09-20");
    });

    it("returns scheduled date for preorders with scheduled date", () => {
        mockDate("2024-09-20T10:00:00Z");

        const result = deriveOrderSeqDate("preorder", "2024-09-25T14:00:00Z");
        assert.strictEqual(result, "2024-09-25");
    });

    it("ignores scheduled date for active orders", () => {
        mockDate("2024-09-20T10:00:00Z");

        // Even if scheduledAt is provided, active orders use current date
        const result = deriveOrderSeqDate("active", "2024-09-25T14:00:00Z");
        assert.strictEqual(result, "2024-09-20");
    });
});

describe("allocateDailySeq", () => {
    let pool;
    let conn;

    before(async () => {
        pool = createTestPool();
        await seedTestData(pool);
    });

    beforeEach(async () => {
        // Clear orders before each test
        await pool.query("DELETE FROM current_orders");
        conn = await pool.getConnection();
    });

    after(async () => {
        if (conn) conn.release();
        await pool.end();
    });

    it("returns 1 for first order of the day", async () => {
        const seq = await allocateDailySeq(conn, 1, "2024-09-20");
        assert.strictEqual(seq, 1);
    });

    it("returns 2 for second order same day", async () => {
        // Insert first order
        await pool.query(
            `INSERT INTO current_orders (company_id, order_seq, order_seq_date, order_type)
             VALUES (1, 1, '2024-09-20', 'active')`
        );

        const seq = await allocateDailySeq(conn, 1, "2024-09-20");
        assert.strictEqual(seq, 2);
    });

    it("returns sequential numbers for multiple orders", async () => {
        // Insert 5 orders
        for (let i = 1; i <= 5; i++) {
            await pool.query(
                `INSERT INTO current_orders (company_id, order_seq, order_seq_date, order_type)
                 VALUES (1, ?, '2024-09-20', 'active')`,
                [i]
            );
        }

        const seq = await allocateDailySeq(conn, 1, "2024-09-20");
        assert.strictEqual(seq, 6);
    });

    it("allocates seq=1 for preorder on future date with no existing orders", async () => {
        // Today has some orders
        await pool.query(
            `INSERT INTO current_orders (company_id, order_seq, order_seq_date, order_type)
             VALUES (1, 1, '2024-09-20', 'active')`
        );

        // But future date (Sept 25) has no orders yet
        const seq = await allocateDailySeq(conn, 1, "2024-09-25");
        assert.strictEqual(seq, 1);
    });

    it("preorders and active orders share sequence on same date", async () => {
        // Two preorders created for Sept 21
        await pool.query(
            `INSERT INTO current_orders (company_id, order_seq, order_seq_date, order_type, scheduled_at)
             VALUES (1, 1, '2024-09-21', 'preorder', '2024-09-21T10:00:00Z')`
        );
        await pool.query(
            `INSERT INTO current_orders (company_id, order_seq, order_seq_date, order_type, scheduled_at)
             VALUES (1, 2, '2024-09-21', 'preorder', '2024-09-21T14:00:00Z')`
        );

        // Now allocate seq for an active order on Sept 21 - should be 3
        const seq = await allocateDailySeq(conn, 1, "2024-09-21");
        assert.strictEqual(seq, 3);
    });

    it("different companies have independent sequences", async () => {
        // Company 1 has 3 orders
        await pool.query(
            `INSERT INTO current_orders (company_id, order_seq, order_seq_date, order_type)
             VALUES (1, 1, '2024-09-20', 'active')`
        );
        await pool.query(
            `INSERT INTO current_orders (company_id, order_seq, order_seq_date, order_type)
             VALUES (1, 2, '2024-09-20', 'active')`
        );
        await pool.query(
            `INSERT INTO current_orders (company_id, order_seq, order_seq_date, order_type)
             VALUES (1, 3, '2024-09-20', 'active')`
        );

        // Company 2 should start at 1
        const seqCompany2 = await allocateDailySeq(conn, 2, "2024-09-20");
        assert.strictEqual(seqCompany2, 1);

        // Company 1 should continue at 4
        const seqCompany1 = await allocateDailySeq(conn, 1, "2024-09-20");
        assert.strictEqual(seqCompany1, 4);
    });

    it("different dates have independent sequences", async () => {
        // Sept 20 has 5 orders
        for (let i = 1; i <= 5; i++) {
            await pool.query(
                `INSERT INTO current_orders (company_id, order_seq, order_seq_date, order_type)
                 VALUES (1, ?, '2024-09-20', 'active')`,
                [i]
            );
        }

        // Sept 21 should start at 1
        const seqSept21 = await allocateDailySeq(conn, 1, "2024-09-21");
        assert.strictEqual(seqSept21, 1);

        // Sept 20 should continue at 6
        const seqSept20 = await allocateDailySeq(conn, 1, "2024-09-20");
        assert.strictEqual(seqSept20, 6);
    });
});

describe("integration: preorder sequence scenario", () => {
    let pool;

    before(async () => {
        pool = createTestPool();
        await seedTestData(pool);
    });

    beforeEach(async () => {
        await pool.query("DELETE FROM current_orders");
        restoreDate();
    });

    after(async () => {
        restoreDate();
        await pool.end();
    });

    it("preorders reserve sequence numbers for their scheduled date", async () => {
        // Scenario: It's Sept 20, we create preorders for Sept 21
        mockDate("2024-09-20T10:00:00Z");

        const conn = await pool.getConnection();

        // Create preorder 1 for Sept 21
        const seqDate1 = deriveOrderSeqDate("preorder", "2024-09-21T10:00:00Z");
        assert.strictEqual(seqDate1, "2024-09-21");
        const seq1 = await allocateDailySeq(conn, 1, seqDate1);
        assert.strictEqual(seq1, 1);

        // Insert the order
        await pool.query(
            `INSERT INTO current_orders (company_id, order_seq, order_seq_date, order_type, scheduled_at)
             VALUES (1, ?, ?, 'preorder', '2024-09-21T10:00:00Z')`,
            [seq1, seqDate1]
        );

        // Create preorder 2 for Sept 21
        const seq2 = await allocateDailySeq(conn, 1, "2024-09-21");
        assert.strictEqual(seq2, 2);

        await pool.query(
            `INSERT INTO current_orders (company_id, order_seq, order_seq_date, order_type, scheduled_at)
             VALUES (1, ?, '2024-09-21', 'preorder', '2024-09-21T14:00:00Z')`,
            [seq2]
        );

        conn.release();

        // Now it's Sept 21, create an active order
        mockDate("2024-09-21T09:00:00Z");

        const conn2 = await pool.getConnection();

        const seqDateActive = deriveOrderSeqDate("active", null);
        assert.strictEqual(seqDateActive, "2024-09-21");

        // Should get seq 3 because preorders took 1 and 2
        const seq3 = await allocateDailySeq(conn2, 1, seqDateActive);
        assert.strictEqual(seq3, 3);

        conn2.release();
    });

    it("active orders on Sept 20 have separate sequence from Sept 21 preorders", async () => {
        mockDate("2024-09-20T10:00:00Z");

        const conn = await pool.getConnection();

        // Create active order for today (Sept 20)
        const seqDateToday = deriveOrderSeqDate("active", null);
        assert.strictEqual(seqDateToday, "2024-09-20");

        const seqToday = await allocateDailySeq(conn, 1, seqDateToday);
        assert.strictEqual(seqToday, 1);

        await pool.query(
            `INSERT INTO current_orders (company_id, order_seq, order_seq_date, order_type)
             VALUES (1, ?, ?, 'active')`,
            [seqToday, seqDateToday]
        );

        // Create preorder for Sept 21
        const seqDateTomorrow = deriveOrderSeqDate("preorder", "2024-09-21T10:00:00Z");
        assert.strictEqual(seqDateTomorrow, "2024-09-21");

        const seqTomorrow = await allocateDailySeq(conn, 1, seqDateTomorrow);
        assert.strictEqual(seqTomorrow, 1); // First order for Sept 21

        await pool.query(
            `INSERT INTO current_orders (company_id, order_seq, order_seq_date, order_type, scheduled_at)
             VALUES (1, ?, ?, 'preorder', '2024-09-21T10:00:00Z')`,
            [seqTomorrow, seqDateTomorrow]
        );

        // Create another active order for today (Sept 20)
        const seqToday2 = await allocateDailySeq(conn, 1, "2024-09-20");
        assert.strictEqual(seqToday2, 2); // Second order for Sept 20

        conn.release();
    });
});
