import fetch from "node-fetch";

export function buildAddressText(order) {
  // order: { address_street, address_house, address_building, address_apartment }
  // Можно дописать city/ country или брать из pickup_point
  const parts = [
    order.address_street,
    order.address_house,
    order.address_building ? `k. ${order.address_building}` : null,
    order.address_apartment ? `apt ${order.address_apartment}` : null,
    "Riga",
    "Latvia",
  ].filter(Boolean).map(s => String(s).trim()).filter(Boolean);

  return parts.join(", ");
}

export async function geoapifyGeocodeByText(text) {
  const apiKey = process.env.GEOAPIFY_KEY;
  if (!apiKey) return { ok: false, error: "GEOAPIFY_KEY missing" };

  const url =
  "https://api.geoapify.com/v1/geocode/search" +
  `?text=${encodeURIComponent(text)}` +
  `&filter=countrycode:lv` +      // ✅ фиксируем Латвию
  `&bias=countrycode:lv` +        // ✅ приоритет Латвии
  `&format=json&limit=1` +
  `&apiKey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "delivery-admin/1.0 (support@yourdomain.com)" },
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
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, error: "Invalid coordinates" };

  return { ok: true, lat, lng, raw: item };
}