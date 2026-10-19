import test from "node:test";
import assert from "node:assert/strict";
import {
    resolvePeriod,
    addDays,
    pctDelta,
    avgCheck,
    fillDaily,
    shapePayments,
    shapeCouriers,
    shapeDiscount,
    money,
    count,
} from "../dashboardLogic.js";

const NOW = new Date("2026-10-19T10:00:00Z");

test("resolvePeriod: today сравнивается с тем же днём неделей раньше", () => {
    const p = resolvePeriod("today", NOW);
    assert.equal(p.from, "2026-10-19");
    assert.equal(p.to, "2026-10-19");
    assert.equal(p.prevFrom, "2026-10-12");
    assert.equal(p.prevTo, "2026-10-12");
    assert.equal(p.chartDays, 14);
    assert.equal(p.chartFrom, "2026-10-06");
});

test("resolvePeriod: 7 и 30 сравниваются с предыдущими равными периодами", () => {
    const p7 = resolvePeriod("7", NOW);
    assert.equal(p7.from, "2026-10-13");
    assert.equal(p7.prevTo, "2026-10-12");
    assert.equal(p7.prevFrom, "2026-10-06");
    const p30 = resolvePeriod("30", NOW);
    assert.equal(p30.from, "2026-09-20");
    assert.equal(p30.prevTo, "2026-09-19");
    assert.equal(p30.prevFrom, "2026-08-21");
    assert.equal(p30.chartDays, 30);
});

test("resolvePeriod: неизвестное значение -> today", () => {
    for (const raw of ["bogus", undefined, null, "", "toString", "__proto__"]) {
        assert.equal(resolvePeriod(raw, NOW).key, "today");
    }
});

test("addDays: переход через месяц и год", () => {
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("pctDelta: null без базы сравнения", () => {
    assert.equal(pctDelta(10, 0), null);
    assert.equal(pctDelta(10, -1), null);
    assert.equal(pctDelta(97.5, 60), 63);
    assert.equal(pctDelta(30, 60), -50);
});

test("avgCheck/money/count", () => {
    assert.equal(avgCheck(100, 0), 0);
    assert.equal(avgCheck(97.5, 7), 13.93);
    assert.equal(money("12.345"), 12.35);
    assert.equal(money(null), 0);
    assert.equal(money("abc"), 0);
    assert.equal(count("7"), 7);
    assert.equal(count(-3), 0);
    assert.equal(count(undefined), 0);
});

test("fillDaily: нули для дней без заказов, ровно N элементов", () => {
    const rows = [{ d: "2026-10-18", sum: "10.50" }, { d: "2026-10-19", sum: 5 }];
    const out = fillDaily(rows, "2026-10-17", 3);
    assert.deepEqual(out, [
        { day: "2026-10-17", sum: 0 },
        { day: "2026-10-18", sum: 10.5 },
        { day: "2026-10-19", sum: 5 },
    ]);
    assert.equal(fillDaily([], "2026-10-01", 14).length, 14);
    assert.equal(fillDaily(null, "2026-10-01", 2).length, 2);
});

test("shapePayments: всегда 4 способа, other только если есть", () => {
    const base = shapePayments([]);
    assert.deepEqual(base.map((x) => x.method), ["cash", "card", "wire", "paid"]);
    assert.ok(base.every((x) => x.share === 0 && x.sum === 0));
    const out = shapePayments([
        { payment_method: "cash", orders: 2, sum: 50 },
        { payment_method: "card", orders: 1, sum: 25 },
        { payment_method: "weird", orders: 1, sum: 25 },
    ]);
    assert.deepEqual(out.map((x) => x.method), ["cash", "card", "wire", "paid", "other"]);
    assert.equal(out[0].share, 50);
    assert.equal(out[4].sum, 25);
});

test("shapeCouriers: неназначенный последним, лимит", () => {
    const rows = [
        { courier_unit_id: null, orders: 9, sum: 90, name: "x" },
        { courier_unit_id: 1, orders: 2, sum: 20, name: "A" },
        { courier_unit_id: 2, orders: 5, sum: 50, name: "B" },
        { courier_unit_id: 3, orders: 1, sum: 10, name: null },
    ];
    const out = shapeCouriers(rows, 2);
    assert.deepEqual(out.map((c) => c.id), [2, 1, null]);
    assert.equal(out[2].name, "");
});

test("shapeDiscount", () => {
    assert.equal(shapeDiscount(null), null);
    assert.equal(shapeDiscount({ discount_type: "percent", discount_value: 0 }), null);
    assert.deepEqual(shapeDiscount({ discount_type: "fixed", discount_value: "5" }), { type: "fixed", value: 5 });
    assert.deepEqual(shapeDiscount({ discount_type: "???", discount_value: 10 }), { type: "percent", value: 10 });
});
