// Подсказки адреса (Geoapify Autocomplete): чистая логика без сети — тестируется отдельно.

export const SUGGEST_MIN_CHARS = 3;
export const SUGGEST_MAX_CHARS = 120;
export const SUGGEST_LIMIT = 5;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа
const CACHE_MAX = 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 40; // запросов в минуту на пользователя

/** Нормализация текста запроса: пробелы, регистр для ключа кэша. */
export function normalizeSuggestText(raw) {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  return text.slice(0, SUGGEST_MAX_CHARS);
}

export function isSuggestTextValid(text) {
  return typeof text === "string" && text.length >= SUGGEST_MIN_CHARS;
}

/** Ответ Geoapify (format=json) → компактный список вариантов для клиента. */
export function normalizeAutocompleteResults(data, limit = SUGGEST_LIMIT) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const seen = new Set();
  const items = [];
  for (const r of results) {
    const street = String(r?.street ?? "").trim();
    if (!street) continue; // без улицы нам нечего подставлять в форму
    const lat = Number(r?.lat);
    const lng = Number(r?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const house = String(r?.housenumber ?? "").trim();
    const city = String(r?.city ?? r?.town ?? r?.village ?? r?.municipality ?? "").trim();
    const suburb = String(r?.suburb ?? r?.district ?? "").trim();
    const postcode = String(r?.postcode ?? "").trim();
    const formatted =
      String(r?.formatted ?? "").trim() ||
      [street + (house ? ` ${house}` : ""), city].filter(Boolean).join(", ");
    const key = formatted.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      formatted,
      street,
      house,
      city,
      suburb,
      postcode,
      lat,
      lng,
      // точный ли это дом (есть номер) — тогда клиент может сразу ставить точку
      exact: !!house,
    });
    if (items.length >= limit) break;
  }
  return items;
}

/** Кэш в памяти с TTL и ограничением размера (самый старый вытесняется). */
export function createSuggestCache({ ttlMs = CACHE_TTL_MS, max = CACHE_MAX, now = Date.now } = {}) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (now() - hit.at > ttlMs) {
        map.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, { at: now(), value });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    size: () => map.size,
  };
}

/** Лимитер «N запросов за окно» на ключ (пользователь). */
export function createRateLimiter({ windowMs = RATE_WINDOW_MS, max = RATE_MAX, now = Date.now } = {}) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
      if (arr.length >= max) {
        hits.set(key, arr);
        return false;
      }
      arr.push(t);
      hits.set(key, arr);
      // чистим старые ключи, чтобы Map не росла бесконечно
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
      }
      return true;
    },
  };
}
