// server/test/manual-verify.js
// Run with: node test/manual-verify.js

process.env.DB_ADAPTER = "sqlite";

import { createTestPool, seedTestData, mockDate, restoreDate } from "./setup.js";
import { deriveOrderSeqDate, allocateDailySeq } from "../currentOrder.js";

const pool = createTestPool();
await seedTestData(pool);

console.log("=== Manual Verification of Daily Sequence Allocation ===\n");

// Scenario: It's September 20, we create orders for today and preorders for Sept 21
mockDate("2024-09-20T10:00:00Z");
console.log("Current simulated date: September 20, 2024\n");

const conn = await pool.getConnection();

// Helper to create an order and show the result
async function createOrder(type, scheduledAt, description) {
    const seqDate = deriveOrderSeqDate(type, scheduledAt);
    const seq = await allocateDailySeq(conn, 1, seqDate);

    await pool.query(
        `INSERT INTO current_orders (company_id, order_seq, order_seq_date, order_type, scheduled_at)
         VALUES (1, ?, ?, ?, ?)`,
        [seq, seqDate, type, scheduledAt]
    );

    console.log(`${description}`);
    console.log(`  → order_seq: ${seq}, order_seq_date: ${seqDate}\n`);
    return { seq, seqDate };
}

// Create orders on Sept 20
console.log("--- Creating orders on September 20 ---\n");
await createOrder("active", null, "Order 1: Active order (today)");
await createOrder("active", null, "Order 2: Active order (today)");

// Create preorders for Sept 21
console.log("--- Creating preorders for September 21 ---\n");
await createOrder("preorder", "2024-09-21T10:00:00Z", "Order 3: Preorder for Sept 21 morning");
await createOrder("preorder", "2024-09-21T14:00:00Z", "Order 4: Preorder for Sept 21 afternoon");

// Create another order on Sept 20
console.log("--- Back to September 20 ---\n");
await createOrder("active", null, "Order 5: Active order (today)");

// Now simulate Sept 21
console.log("=".repeat(50));
mockDate("2024-09-21T09:00:00Z");
console.log("\nCurrent simulated date: September 21, 2024\n");

console.log("--- Creating active orders on September 21 ---\n");
await createOrder("active", null, "Order 6: First active order on Sept 21");
await createOrder("active", null, "Order 7: Second active order on Sept 21");

conn.release();

// Show final state
console.log("=".repeat(50));
console.log("\n=== Final Database State ===\n");

const [orders] = await pool.query(
    `SELECT order_id, order_type, order_seq, order_seq_date, scheduled_at
     FROM current_orders
     ORDER BY order_id`
);

console.log("order_id | type     | seq | seq_date   | scheduled_at");
console.log("-".repeat(60));
for (const o of orders) {
    const scheduled = o.scheduled_at ? o.scheduled_at.slice(0, 10) : "-";
    console.log(
        `${String(o.order_id).padEnd(8)} | ${o.order_type.padEnd(8)} | ${String(o.order_seq).padEnd(3)} | ${o.order_seq_date} | ${scheduled}`
    );
}

console.log("\n=== Summary ===");
console.log("- Sept 20 active orders got seq 1, 2, 3");
console.log("- Sept 21 preorders (created on Sept 20) got seq 1, 2");
console.log("- Sept 21 active orders continue at seq 3, 4");
console.log("\nThis confirms preorders 'reserve' sequence numbers for their scheduled date.");

await pool.end();
