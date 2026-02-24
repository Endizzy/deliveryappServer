import fetch from "node-fetch";

export function buildAddressText(order) {
  const street = String(order.address_street || "").trim();
  const house = String(order.address_house || "").trim();
  const building = String(order.address_building || "").trim();
  const apart = String(order.address_apartment || "").trim();

  // Пример: "Ozolciema iela 32 k-4"
  const main =
    street && house
      ? `${street} ${house}${building ? ` k-${building}` : ""}`
      : street || "";

  // Квартира (если используешь). Можно заменить на "apt" если тебе так привычнее.
  const aptPart = apart ? ` dz. ${apart}` : "";

  const text = `${main}${aptPart}, Riga, Latvia`.trim();

  // если street пустая — не шлём мусор
  return street ? text : "";
}

export async function geoapifyGeocodeByText(text) {
  const apiKey = process.env.GEOAPIFY_KEY;
  if (!apiKey) return { ok: false, error: "GEOAPIFY_KEY missing" };

  const url =
    "https://api.geoapify.com/v1/geocode/search" +
    `?text=${encodeURIComponent(text)}` +
    `&filter=countrycode:lv` + // фиксируем Латвию
    `&bias=countrycode:lv` +   // приоритет Латвии
    `&format=json&limit=1` +
    `&apiKey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "delivery-admin/1.0" },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Geoapify ${res.status}: ${body.slice(0, 200)}` };
  }

  const data = await res.json();
  const item = data?.results?.[0];
  if (!item) return { ok: false, error: "No geocode results" };

  const lat = Number(item.lat);
  const lng = Number(item.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: "Invalid coordinates" };
  }

  return { ok: true, lat, lng, raw: item };
}