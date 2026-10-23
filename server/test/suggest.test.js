import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSuggestText,
  isSuggestTextValid,
  normalizeAutocompleteResults,
  createSuggestCache,
  createRateLimiter,
} from "../services/geoapify/suggestLogic.js";

test("текст: пробелы схлопываются, короткий не проходит", () => {
  assert.equal(normalizeSuggestText("  Brīvības   iela  40 "), "Brīvības iela 40");
  assert.equal(normalizeSuggestText(null), "");
  assert.equal(isSuggestTextValid("ab"), false);
  assert.equal(isSuggestTextValid("abc"), true);
  assert.equal(normalizeSuggestText("x".repeat(500)).length, 120);
});

test("результаты: нормализация, дубли и записи без улицы/координат отбрасываются", () => {
  const data = {
    results: [
      { street: "Brīvības iela", housenumber: "40", city: "Rīga", suburb: "Centrs", postcode: "LV-1050", lat: 56.95, lon: 24.11, formatted: "Brīvības iela 40, Centra rajons, Rīga, LV-1050, Latvija" },
      { street: "Brīvības iela", housenumber: "40", city: "Rīga", lat: 56.95, lon: 24.11, formatted: "Brīvības iela 40, Centra rajons, Rīga, LV-1050, Latvija" },
      { street: "", city: "Rīga", lat: 56.9, lon: 24.1, formatted: "Rīga" },
      { street: "Brīvības iela", city: "Rīga", lat: "abc", lon: 24.1, formatted: "bad" },
      { street: "Brīvības iela", city: "Rīga", lat: 56.96, lon: 24.12, formatted: "Brīvības iela, Rīga" },
    ],
  };
  const items = normalizeAutocompleteResults(data);
  assert.equal(items.length, 2);
  assert.equal(items[0].exact, true);
  assert.equal(items[0].house, "40");
  assert.equal(items[1].exact, false);
  assert.equal(items[1].house, "");
  assert.deepEqual(normalizeAutocompleteResults(null), []);
  assert.deepEqual(normalizeAutocompleteResults({}), []);
});

test("результаты: ограничение по limit", () => {
  const results = Array.from({ length: 9 }, (_, i) => ({ street: "S", housenumber: String(i), lat: 1, lon: 2, formatted: "S " + i }));
  assert.equal(normalizeAutocompleteResults({ results }, 5).length, 5);
});

test("кэш: TTL и вытеснение", () => {
  let t = 0;
  const c = createSuggestCache({ ttlMs: 100, max: 2, now: () => t });
  c.set("a", [1]);
  assert.deepEqual(c.get("a"), [1]);
  t = 101;
  assert.equal(c.get("a"), undefined);
  c.set("a", 1); c.set("b", 2); c.set("c", 3);
  assert.equal(c.get("a"), undefined);
  assert.equal(c.size(), 2);
});

test("лимитер: N в окне, потом окно сбрасывается, ключи независимы", () => {
  let t = 0;
  const l = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
  assert.equal(l.allow("u1"), true);
  assert.equal(l.allow("u1"), true);
  assert.equal(l.allow("u1"), false);
  assert.equal(l.allow("u2"), true);
  t = 1001;
  assert.equal(l.allow("u1"), true);
});
