import test from "node:test";
import assert from "node:assert/strict";
import {
    sanitizeLoyaltySettings,
    evaluateProgress,
    loyaltyDiscountCents,
    pickOrderDiscount,
    classifyProgress,
} from "../loyaltyLogic.js";

test("evaluateProgress: при N=10 скидка на 11-м заказе", () => {
    assert.deepEqual(evaluateProgress(0, 10), { position: 1, willApply: false, ordersBefore: 10 });
    assert.equal(evaluateProgress(9, 10).willApply, false);
    assert.equal(evaluateProgress(9, 10).position, 10);
    const eleventh = evaluateProgress(10, 10);
    assert.equal(eleventh.position, 11);
    assert.equal(eleventh.willApply, true);
});

test("evaluateProgress: N уменьшили ниже накопленного — скидка положена (>=)", () => {
    assert.equal(evaluateProgress(15, 10).willApply, true);
});

test("evaluateProgress: мусор на входе не ломает", () => {
    assert.equal(evaluateProgress(undefined, 10).position, 1);
    assert.equal(evaluateProgress("abc", "x").willApply, false);
    assert.equal(evaluateProgress(-5, 3).position, 1);
});

test("loyaltyDiscountCents: fixed не больше суммы позиций", () => {
    assert.equal(loyaltyDiscountCents({ type: "fixed", value: 5 }, 4000, 4000), 500);
    assert.equal(loyaltyDiscountCents({ type: "fixed", value: 50 }, 1200, 1200), 1200);
});

test("loyaltyDiscountCents: percent только от позиций без скидки меню", () => {
    // сумма 40 €, из них без скидки в меню 30 €
    assert.equal(loyaltyDiscountCents({ type: "percent", value: 10 }, 4000, 3000), 300);
    assert.equal(loyaltyDiscountCents({ type: "percent", value: 100 }, 4000, 3000), 3000);
    assert.equal(loyaltyDiscountCents({ type: "percent", value: 150 }, 4000, 3000), 3000);
});

test("loyaltyDiscountCents: пусто/ноль/null → 0", () => {
    assert.equal(loyaltyDiscountCents(null, 1000, 1000), 0);
    assert.equal(loyaltyDiscountCents({ type: "fixed", value: 0 }, 1000, 1000), 0);
    assert.equal(loyaltyDiscountCents({ type: "fixed", value: "abc" }, 1000, 1000), 0);
});

test("pickOrderDiscount: берётся наибольшая, скидки не складываются", () => {
    assert.deepEqual(pickOrderDiscount(300, 200, 500), { orderDiscountCents: 500, loyaltyWon: true });
    assert.deepEqual(pickOrderDiscount(800, 200, 500), { orderDiscountCents: 800, loyaltyWon: false });
});

test("pickOrderDiscount: при равенстве лояльность НЕ сгорает", () => {
    assert.deepEqual(pickOrderDiscount(500, 0, 500), { orderDiscountCents: 500, loyaltyWon: false });
});

test("pickOrderDiscount: без других скидок побеждает лояльность; без лояльности — как раньше", () => {
    assert.deepEqual(pickOrderDiscount(0, 0, 500), { orderDiscountCents: 500, loyaltyWon: true });
    assert.deepEqual(pickOrderDiscount(300, 200, 0), { orderDiscountCents: 300, loyaltyWon: false });
    assert.deepEqual(pickOrderDiscount(0, 0, 0), { orderDiscountCents: 0, loyaltyWon: false });
});

test("sanitizeLoyaltySettings: валидные значения", () => {
    const r = sanitizeLoyaltySettings({ enabled: true, ordersBefore: "10", type: "fixed", value: "5,5" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { enabled: true, ordersBefore: 10, type: "fixed", value: 5.5 });
});

test("sanitizeLoyaltySettings: границы", () => {
    assert.equal(sanitizeLoyaltySettings({ ordersBefore: 0, type: "fixed", value: 5 }).ok, false);
    assert.equal(sanitizeLoyaltySettings({ ordersBefore: 101, type: "fixed", value: 5 }).ok, false);
    assert.equal(sanitizeLoyaltySettings({ ordersBefore: 5, type: "fixed", value: 0 }).ok, false);
    assert.equal(sanitizeLoyaltySettings({ ordersBefore: 5, type: "fixed", value: -1 }).ok, false);
    assert.equal(sanitizeLoyaltySettings({ ordersBefore: 5, type: "percent", value: 101 }).ok, false);
    assert.equal(sanitizeLoyaltySettings({ ordersBefore: 5, type: "fixed", value: 1001 }).ok, false);
    assert.equal(sanitizeLoyaltySettings({ ordersBefore: 5, type: "percent", value: 100 }).ok, true);
    assert.equal(sanitizeLoyaltySettings({ ordersBefore: 100, type: "fixed", value: 1000 }).ok, true);
});

test("sanitizeLoyaltySettings: неизвестный тип → fixed, enabled только для true/1", () => {
    const r = sanitizeLoyaltySettings({ enabled: "yes", ordersBefore: 3, type: "weird", value: 2 });
    assert.equal(r.value.type, "fixed");
    assert.equal(r.value.enabled, false);
});

test("classifyProgress: копят / скоро / готово", () => {
    assert.deepEqual(classifyProgress(3, 10), { ordersCount: 3, ordersBefore: 10, ready: false, remaining: 7, soon: false });
    assert.deepEqual(classifyProgress(8, 10), { ordersCount: 8, ordersBefore: 10, ready: false, remaining: 2, soon: true });
    assert.deepEqual(classifyProgress(9, 10), { ordersCount: 9, ordersBefore: 10, ready: false, remaining: 1, soon: true });
    assert.deepEqual(classifyProgress(10, 10), { ordersCount: 10, ordersBefore: 10, ready: true, remaining: 0, soon: false });
});

test("classifyProgress: накопили больше порога (N уменьшили) — готово, remaining не отрицательный", () => {
    const p = classifyProgress(15, 10);
    assert.equal(p.ready, true);
    assert.equal(p.remaining, 0);
    assert.equal(p.soon, false);
});

test("classifyProgress: согласована с evaluateProgress (ready ⇔ willApply)", () => {
    for (let n = 1; n <= 6; n++) {
        for (let c = 0; c <= 8; c++) {
            assert.equal(classifyProgress(c, n).ready, evaluateProgress(c, n).willApply);
        }
    }
});

test("classifyProgress: мусор на входе не ломает", () => {
    assert.equal(classifyProgress(undefined, undefined).ordersBefore, 1);
    assert.equal(classifyProgress("abc", 5).ordersCount, 0);
    assert.equal(classifyProgress(-3, 5).remaining, 5);
});
