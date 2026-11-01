// ─────────────────────────────────────────────────────────────────────────────
// Журнал изменений заказов — чистая логика (без БД), покрыта тестами
// (test/orderAudit.test.js).
//
// Из двух состояний заказа («до» и «после» — строки current_orders, как их
// отдаёт БД) строится список событий журнала. Ничего не пишет и не бросает
// исключений: любая неожиданность в данных означает «событий нет».
// ─────────────────────────────────────────────────────────────────────────────

// Типы событий (event_type в БД). Клиент переводит их на свой язык.
export const AUDIT_EVENT_TYPES = [
  "created", "status", "courier", "pickup", "address", "point", "items",
  "amount", "discount", "loyalty", "delivery_fee", "payment", "schedule",
  "customer", "people", "notes",
];

// Метки важности (flag в БД)
export const AUDIT_FLAGS = [
  "after_delivery", "cancel", "reopen", "courier_change", "manual_discount",
];

export const AUDIT_SOURCES = ["web", "courier_app", "system"];

const VALUE_MAX = 600;

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

const clip = (s) => {
  const t = str(s);
  return t.length > VALUE_MAX ? `${t.slice(0, VALUE_MAX - 1)}…` : t;
};

const cents = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

const money = (v) => (cents(v) / 100).toFixed(2);

// «Нет значения» хранится как null: на клиенте это «—»
const orNull = (s) => {
  const t = clip(s);
  return t === "" ? null : t;
};

const toMs = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
};

// DATE из БД (Date или строка) → "YYYY-MM-DD" или null
export function toDayString(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = (n) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// ── позиции заказа ───────────────────────────────────────────────────────────

export function parseItems(raw) {
  let arr = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(arr) ? arr : [];
}

const qtyText = (q) => {
  const n = Number(q);
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : "?";
};

// Сводим позиции по ключу (id, иначе название): одинаковые строки суммируются.
function indexItems(items) {
  const map = new Map();
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const name = str(it.name) || "—";
    const key = it.id != null && it.id !== "" ? `id:${it.id}` : `n:${name.toLowerCase()}`;
    const qty = Number(it.quantity) || 0;
    const price = cents(it.price);
    const discount = Number(it.discount) || 0;
    const cur = map.get(key);
    if (cur) cur.qty += qty;
    else map.set(key, { name, qty, price, discount });
  }
  return map;
}

// → { oldText, newText } или null, если позиции не менялись
export function diffItems(oldRaw, newRaw) {
  const a = indexItems(parseItems(oldRaw));
  const b = indexItems(parseItems(newRaw));
  const oldLines = [];
  const newLines = [];

  for (const [key, o] of a) {
    const n = b.get(key);
    if (!n) {
      oldLines.push(`${o.name} ×${qtyText(o.qty)}`);
    } else if (o.qty !== n.qty || o.price !== n.price || o.discount !== n.discount) {
      const priceChanged = o.price !== n.price || o.discount !== n.discount;
      oldLines.push(`${o.name} ×${qtyText(o.qty)}${priceChanged ? ` (${money(o.price / 100)} €)` : ""}`);
      newLines.push(`${n.name} ×${qtyText(n.qty)}${priceChanged ? ` (${money(n.price / 100)} €)` : ""}`);
    }
  }
  for (const [key, n] of b) {
    if (!a.has(key)) newLines.push(`${n.name} ×${qtyText(n.qty)}`);
  }

  if (!oldLines.length && !newLines.length) return null;
  return { oldText: oldLines.join("; "), newText: newLines.join("; ") };
}

// ── адрес ────────────────────────────────────────────────────────────────────

const ADDRESS_FIELDS = [
  "address_street", "address_house", "address_building",
  "address_apartment", "address_floor", "address_code",
];

export function formatAddress(r) {
  if (!r) return "";
  return [
    str(r.address_street),
    str(r.address_house) && `д.${str(r.address_house)}`,
    str(r.address_building) && `к.${str(r.address_building)}`,
    str(r.address_apartment) && `кв.${str(r.address_apartment)}`,
    str(r.address_floor) && `эт.${str(r.address_floor)}`,
    str(r.address_code) && `код ${str(r.address_code)}`,
  ].filter(Boolean).join(", ");
}

const pointText = (r) => {
  const lat = r?.address_lat, lng = r?.address_lng;
  if (lat == null || lng == null) return "";
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "";
  return `${a.toFixed(5)}, ${b.toFixed(5)}`;
};

const POINT_EPS = 0.00005; // ≈ 5 м

function pointMoved(before, after) {
  const bt = pointText(before), at = pointText(after);
  if (bt === at) return false;
  if (!bt || !at) return true;
  const dLat = Math.abs(Number(before.address_lat) - Number(after.address_lat));
  const dLng = Math.abs(Number(before.address_lng) - Number(after.address_lng));
  return dLat > POINT_EPS || dLng > POINT_EPS;
}

// ── курьер / ресторан ────────────────────────────────────────────────────────

const unitName = (id, nick) => {
  if (id === null || id === undefined || id === "") return "";
  return str(nick) || `#${id}`;
};

// ── график ───────────────────────────────────────────────────────────────────

const scheduleText = (r) => {
  const t = str(r?.order_type) || "active";
  const ms = toMs(r?.scheduled_at);
  return ms ? `${t} @ ${new Date(ms).toISOString()}` : t;
};

// ── главная функция ──────────────────────────────────────────────────────────

/**
 * Сравнивает состояния заказа и возвращает события журнала.
 * @param before строка заказа до правки (или null)
 * @param after  строка заказа после правки
 * @returns [{ event_type, old_value, new_value, amount_delta, important, flag }]
 */
export function buildAuditEvents(before, after) {
  try {
    if (!after || typeof after !== "object") return [];
    if (!before || typeof before !== "object") return [];

    const ev = [];
    const push = (event_type, oldV, newV, extra = {}) =>
      ev.push({
        event_type,
        old_value: orNull(oldV),
        new_value: orNull(newV),
        amount_delta: extra.amount_delta ?? null,
        important: extra.flag ? 1 : 0,
        flag: extra.flag ?? null,
      });

    const wasCompleted = str(before.status) === "completed";

    // статус
    if (str(before.status) !== str(after.status)) {
      let flag = null;
      if (str(after.status) === "cancelled") flag = "cancel";
      else if (wasCompleted) flag = "reopen";
      push("status", before.status, after.status, { flag });
    }

    // курьер (смена после назначения — важное событие)
    const bc = str(before.courier_unit_id), ac = str(after.courier_unit_id);
    if (bc !== ac) {
      push(
        "courier",
        unitName(before.courier_unit_id, before.courier_nickname),
        unitName(after.courier_unit_id, after.courier_nickname),
        { flag: bc !== "" ? "courier_change" : null }
      );
    }

    // ресторан комплектации
    if (str(before.pickup_unit_id) !== str(after.pickup_unit_id)) {
      push(
        "pickup",
        unitName(before.pickup_unit_id, before.pickup_nickname),
        unitName(after.pickup_unit_id, after.pickup_nickname)
      );
    }

    // адрес одной записью
    if (ADDRESS_FIELDS.some((f) => str(before[f]) !== str(after[f]))) {
      push("address", formatAddress(before), formatAddress(after));
    }

    // точка на карте
    if (pointMoved(before, after)) {
      push("point", pointText(before), pointText(after));
    }

    // позиции
    const items = diffItems(before.items_json, after.items_json);
    if (items) push("items", items.oldText, items.newText);

    // сумма (после доставки — важное событие)
    if (cents(before.amount_total) !== cents(after.amount_total)) {
      push("amount", money(before.amount_total), money(after.amount_total), {
        amount_delta: (cents(after.amount_total) - cents(before.amount_total)) / 100,
        flag: wasCompleted ? "after_delivery" : null,
      });
    }

    // разовая (ручная) скидка
    const bm = Number(before.manual_discount_percent) || 0;
    const am = Number(after.manual_discount_percent) || 0;
    if (bm !== am) {
      push("discount", bm ? `${bm}%` : "", am ? `${am}%` : "", {
        flag: am > bm ? "manual_discount" : null,
      });
    }

    // скидка лояльности снята или выдана
    const bl = Number(before.loyalty_applied) === 1;
    const al = Number(after.loyalty_applied) === 1;
    if (bl !== al) push("loyalty", bl ? "1" : "0", al ? "1" : "0");

    // доставка
    if (cents(before.delivery_fee) !== cents(after.delivery_fee)) {
      push("delivery_fee", money(before.delivery_fee), money(after.delivery_fee), {
        amount_delta: (cents(after.delivery_fee) - cents(before.delivery_fee)) / 100,
      });
    }

    // способ оплаты
    if (str(before.payment_method) !== str(after.payment_method)) {
      push("payment", before.payment_method, after.payment_method);
    }

    // тип заказа и время предзаказа
    if (scheduleText(before) !== scheduleText(after)) {
      push("schedule", scheduleText(before), scheduleText(after));
    }

    // клиент
    if (
      str(before.customer_name) !== str(after.customer_name) ||
      str(before.customer_phone) !== str(after.customer_phone)
    ) {
      const j = (r) => [str(r.customer_name), str(r.customer_phone)].filter(Boolean).join(" · ");
      push("customer", j(before), j(after));
    }

    // количество персон, заметка
    if (str(before.people_amount) !== str(after.people_amount)) {
      push("people", before.people_amount, after.people_amount);
    }
    if (str(before.notes) !== str(after.notes)) {
      push("notes", before.notes, after.notes);
    }

    return ev;
  } catch {
    return [];
  }
}

/** Событие «заказ создан» */
export function buildCreatedEvent(after) {
  try {
    if (!after || typeof after !== "object") return null;
    const n = parseItems(after.items_json).length;
    const parts = [
      scheduleText(after).split(" @ ")[0],
      str(after.payment_method),
      `${n}`,
    ];
    return {
      event_type: "created",
      old_value: null,
      // «тип|оплата|число позиций» — клиент собирает из этого читаемую строку
      new_value: parts.join("|"),
      amount_delta: Number(after.amount_total) || 0,
      important: 0,
      flag: null,
    };
  } catch {
    return null;
  }
}

/** Данные заказа, которые копируются в каждую строку журнала */
export function orderSnapshotFields(row) {
  const r = row || {};
  return {
    order_id: Number(r.order_id) || 0,
    order_no: str(r.order_no).slice(0, 64) || null,
    order_seq: r.order_seq != null && Number.isFinite(Number(r.order_seq)) ? Number(r.order_seq) : null,
    order_seq_date: toDayString(r.order_seq_date),
    customer_name: str(r.customer_name).slice(0, 255) || null,
    customer_phone: str(r.customer_phone).slice(0, 32) || null,
  };
}
