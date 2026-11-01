import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAuditEvents,
  buildCreatedEvent,
  diffItems,
  formatAddress,
  orderSnapshotFields,
  toDayString,
} from "../orderAuditLogic.js";
import { parseAuditQuery } from "../orderAuditQuery.js";
import { AUDIT_EVENT_TYPES, AUDIT_SOURCES } from "../orderAuditLogic.js";

const base = () => ({
  order_id: 1284,
  order_no: "CO-1",
  order_seq: 12,
  order_seq_date: "2026-10-31",
  order_type: "active",
  status: "new",
  scheduled_at: null,
  courier_unit_id: null,
  courier_nickname: null,
  pickup_unit_id: 5,
  pickup_nickname: "Centrs",
  payment_method: "cash",
  delivery_fee: "2.00",
  customer_name: "Anna",
  customer_phone: "+37126123456",
  address_street: "Brīvības iela",
  address_house: "40",
  address_building: null,
  address_apartment: "12",
  address_floor: "3",
  address_code: "1234",
  address_lat: "56.95140",
  address_lng: "24.11360",
  people_amount: 2,
  notes: null,
  manual_discount_percent: "0.00",
  loyalty_applied: 0,
  items_json: JSON.stringify([{ id: 1, name: "Pizza", quantity: 1, price: 8.9, discount: 0 }]),
  amount_subtotal: "8.90",
  amount_discount: "0.00",
  amount_total: "10.90",
});

const types = (ev) => ev.map((e) => e.event_type);

test("без изменений — событий нет", () => {
  assert.deepEqual(buildAuditEvents(base(), base()), []);
});

test("нет «до» или «после» — пустой список, без исключений", () => {
  assert.deepEqual(buildAuditEvents(null, base()), []);
  assert.deepEqual(buildAuditEvents(base(), null), []);
  assert.deepEqual(buildAuditEvents(undefined, undefined), []);
});

test("строки и числа одного значения не считаются изменением", () => {
  const a = base();
  const b = { ...base(), amount_total: 10.9, delivery_fee: 2, people_amount: "2", courier_unit_id: "" };
  assert.deepEqual(buildAuditEvents(a, b), []);
});

test("статус: обычный не важный, отмена и возврат из «выполнен» важные", () => {
  const a = base();
  let ev = buildAuditEvents(a, { ...a, status: "preparing" });
  assert.deepEqual(types(ev), ["status"]);
  assert.equal(ev[0].important, 0);
  assert.equal(ev[0].old_value, "new");
  assert.equal(ev[0].new_value, "preparing");

  ev = buildAuditEvents(a, { ...a, status: "cancelled" });
  assert.equal(ev[0].flag, "cancel");
  assert.equal(ev[0].important, 1);

  ev = buildAuditEvents({ ...a, status: "completed" }, { ...a, status: "enroute" });
  assert.equal(ev[0].flag, "reopen");
});

test("курьер: назначение не важное, смена после назначения — важная", () => {
  const a = base();
  let ev = buildAuditEvents(a, { ...a, courier_unit_id: 7, courier_nickname: "Jānis" });
  assert.deepEqual(types(ev), ["courier"]);
  assert.equal(ev[0].old_value, null);
  assert.equal(ev[0].new_value, "Jānis");
  assert.equal(ev[0].important, 0);

  const withCourier = { ...a, courier_unit_id: 7, courier_nickname: "Jānis" };
  ev = buildAuditEvents(withCourier, { ...a, courier_unit_id: 8, courier_nickname: "Pēteris" });
  assert.equal(ev[0].flag, "courier_change");
  assert.equal(ev[0].old_value, "Jānis");

  ev = buildAuditEvents(withCourier, { ...a, courier_unit_id: null, courier_nickname: null });
  assert.equal(ev[0].new_value, null);
  assert.equal(ev[0].flag, "courier_change");
});

test("курьер без названия — показывается #id", () => {
  const a = base();
  const ev = buildAuditEvents(a, { ...a, courier_unit_id: 9, courier_nickname: null });
  assert.equal(ev[0].new_value, "#9");
});

test("ресторан комплектации", () => {
  const a = base();
  const ev = buildAuditEvents(a, { ...a, pickup_unit_id: 6, pickup_nickname: "Jugla" });
  assert.deepEqual(types(ev), ["pickup"]);
  assert.equal(ev[0].old_value, "Centrs");
  assert.equal(ev[0].new_value, "Jugla");
});

test("адрес — одной записью, пустые поля не мешают", () => {
  const a = base();
  const ev = buildAuditEvents(a, { ...a, address_street: "Elizabetes iela", address_house: "22", address_building: "2" });
  assert.deepEqual(types(ev), ["address"]);
  assert.equal(ev[0].old_value, "Brīvības iela, д.40, кв.12, эт.3, код 1234");
  assert.equal(ev[0].new_value, "Elizabetes iela, д.22, к.2, кв.12, эт.3, код 1234");
  assert.equal(formatAddress(null), "");
});

test("точка на карте: сдвиг менее 5 м игнорируется, больший — событие", () => {
  const a = base();
  assert.deepEqual(buildAuditEvents(a, { ...a, address_lat: "56.95142" }), []);
  const ev = buildAuditEvents(a, { ...a, address_lat: "56.9487", address_lng: "24.1189" });
  assert.deepEqual(types(ev), ["point"]);
  assert.equal(ev[0].old_value, "56.95140, 24.11360");
  assert.equal(ev[0].new_value, "56.94870, 24.11890");
});

test("позиции: добавлена, удалена, изменено количество", () => {
  const oldJ = JSON.stringify([
    { id: 1, name: "Pizza", quantity: 1, price: 8.9 },
    { id: 2, name: "Cola", quantity: 2, price: 1.5 },
  ]);
  const newJ = JSON.stringify([
    { id: 1, name: "Pizza", quantity: 2, price: 8.9 },
    { id: 3, name: "Soup", quantity: 1, price: 4 },
  ]);
  const d = diffItems(oldJ, newJ);
  assert.equal(d.oldText, "Pizza ×1; Cola ×2");
  assert.equal(d.newText, "Pizza ×2; Soup ×1");
  assert.equal(diffItems(oldJ, oldJ), null);
  assert.equal(diffItems("не json", "[]"), null);
});

test("позиции: изменение цены показывает цену", () => {
  const d = diffItems(
    JSON.stringify([{ id: 1, name: "Pizza", quantity: 1, price: 8.9 }]),
    JSON.stringify([{ id: 1, name: "Pizza", quantity: 1, price: 9.5 }])
  );
  assert.equal(d.oldText, "Pizza ×1 (8.90 €)");
  assert.equal(d.newText, "Pizza ×1 (9.50 €)");
});

test("сумма: разница, важная метка только после доставки", () => {
  const a = base();
  let ev = buildAuditEvents(a, { ...a, amount_total: "12.00" });
  assert.deepEqual(types(ev), ["amount"]);
  assert.equal(ev[0].amount_delta, 1.1);
  assert.equal(ev[0].flag, null);

  ev = buildAuditEvents({ ...a, status: "completed" }, { ...a, status: "completed", amount_total: "8.00" });
  const amount = ev.find((e) => e.event_type === "amount");
  assert.equal(amount.flag, "after_delivery");
  assert.equal(amount.important, 1);
  assert.equal(amount.amount_delta, -2.9);
});

test("ручная скидка: рост — важное, снятие — нет", () => {
  const a = base();
  let ev = buildAuditEvents(a, { ...a, manual_discount_percent: "10.00" });
  assert.equal(ev[0].event_type, "discount");
  assert.equal(ev[0].new_value, "10%");
  assert.equal(ev[0].flag, "manual_discount");
  ev = buildAuditEvents({ ...a, manual_discount_percent: "10.00" }, a);
  assert.equal(ev[0].new_value, null);
  assert.equal(ev[0].flag, null);
});

test("скидка лояльности, доставка, оплата, клиент, персоны, заметка", () => {
  const a = base();
  const ev = buildAuditEvents(a, {
    ...a,
    loyalty_applied: 1,
    delivery_fee: "3.50",
    payment_method: "card",
    customer_name: "Anna O.",
    people_amount: 3,
    notes: "позвонить",
  });
  assert.deepEqual(types(ev), ["loyalty", "delivery_fee", "payment", "customer", "people", "notes"]);
  assert.equal(ev.find((e) => e.event_type === "delivery_fee").amount_delta, 1.5);
});

test("предзаказ: смена типа и времени", () => {
  const a = base();
  const ev = buildAuditEvents(a, { ...a, order_type: "preorder", scheduled_at: new Date("2026-11-01T10:00:00Z") });
  assert.deepEqual(types(ev), ["schedule"]);
  assert.equal(ev[0].old_value, "active");
  assert.equal(ev[0].new_value, "preorder @ 2026-11-01T10:00:00.000Z");
});

test("длинные значения обрезаются", () => {
  const a = base();
  const ev = buildAuditEvents(a, { ...a, notes: "x".repeat(2000) });
  assert.equal(ev[0].new_value.length, 600);
});

test("событие «создан»", () => {
  const e = buildCreatedEvent(base());
  assert.equal(e.event_type, "created");
  assert.equal(e.new_value, "active|cash|1");
  assert.equal(e.amount_delta, 10.9);
  assert.equal(buildCreatedEvent(null), null);
});

test("данные заказа для строки журнала", () => {
  const s = orderSnapshotFields(base());
  assert.equal(s.order_id, 1284);
  assert.equal(s.order_seq, 12);
  assert.equal(s.order_seq_date, "2026-10-31");
  assert.equal(s.customer_phone, "+37126123456");
  assert.equal(toDayString("2026-10-31T00:00:00.000Z"), "2026-10-31");
  assert.equal(toDayString(null), null);
  assert.equal(orderSnapshotFields(null).order_id, 0);
});

// ── разбор запроса ───────────────────────────────────────────────────────────

const NOW = new Date("2026-11-01T12:00:00Z");
const opt = { types: AUDIT_EVENT_TYPES, sources: AUDIT_SOURCES };

test("запрос: значения по умолчанию — последние 7 дней", () => {
  const f = parseAuditQuery({}, opt, NOW);
  assert.equal(f.page, 1);
  assert.equal(f.pageSize, 50);
  assert.equal(f.actor, null);
  assert.equal(f.type, null);
  assert.equal(f.important, false);
  assert.equal(f.exportAll, false);
  assert.equal(Math.round((f.to - f.from) / 86400000), 7);
});

test("запрос: мусор заменяется безопасными значениями", () => {
  const f = parseAuditQuery(
    { from: "abc", to: "xyz", actor: "-5", type: "drop table", source: "hack", page: "0", pageSize: "100000", q: "  a   b  " },
    opt,
    NOW
  );
  assert.equal(f.actor, null);
  assert.equal(f.type, null);
  assert.equal(f.source, null);
  assert.equal(f.page, 1);
  assert.equal(f.pageSize, 100);
  assert.equal(f.q, "a b");
});

test("запрос: допустимые значения проходят, период ограничен годом", () => {
  const f = parseAuditQuery(
    { from: "2020-01-01T00:00:00Z", to: "2026-10-31T00:00:00Z", actor: "7", type: "amount", source: "web", important: "1", page: "3", pageSize: "20", export: "1" },
    opt,
    NOW
  );
  assert.equal(f.actor, 7);
  assert.equal(f.type, "amount");
  assert.equal(f.source, "web");
  assert.equal(f.important, true);
  assert.equal(f.page, 3);
  assert.equal(f.pageSize, 20);
  assert.equal(f.exportAll, true);
  assert.ok(Math.round((f.to - f.from) / 86400000) <= 366);
});

test("запрос: from позже to — берутся 7 дней до to", () => {
  const f = parseAuditQuery({ from: "2026-11-05T00:00:00Z", to: "2026-11-01T00:00:00Z" }, opt, NOW);
  assert.ok(f.from < f.to);
});
