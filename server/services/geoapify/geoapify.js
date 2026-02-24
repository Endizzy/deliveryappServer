import fetch from "node-fetch";

export function buildAddressText(order) {
  // поддерживаем оба формата ключей:
  // - из БД: address_street/address_house/address_building/address_apartment
  // - из body: street/house/building/apart
  const street = String(order.address_street ?? order.street ?? "").trim();
  const house = String(order.address_house ?? order.house ?? "").trim();
  const building = String(order.address_building ?? order.building ?? "").trim();
  const apart = String(order.address_apartment ?? order.apart ?? "").trim();

  if (!street) return "";

  // ВАЖНО: корпус берём ТОЛЬКО из поля "building", дом не парсим
  const main =
    house
      ? `${street} ${house}${building ? ` k-${building}` : ""}`
      : street;

  // Квартира (можешь убрать совсем, если не хочешь)
  const aptPart = apart ? ` dz. ${apart}` : "";

  return `${main}${aptPart}, Riga, Latvia`.trim();
}

export async function geoapifyGeocodeByText(text) {
  const apiKey = process.env.GEOAPIFY_KEY;
  if (!apiKey) return { ok: false, error: "GEOAPIFY_KEY missing" };

  const url =
    "https://api.geoapify.com/v1/geocode/search" +
    `?text=${encodeURIComponent(text)}` +
    `&filter=countrycode:lv` +
    `&bias=countrycode:lv` +
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