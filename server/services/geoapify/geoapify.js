import fetch from "node-fetch";

export function buildAddressText(order) {
  const street = (order.address_street || "").trim();
  const house = (order.address_house || "").trim();
  const building = (order.address_building || "").trim();
  const apart = (order.address_apartment || "").trim();

  // дом + корпус: "2/1"
  const housePart = building ? `${house}/${building}` : house;

  const parts = [
    street,
    housePart,
    apart ? `- ${apart}` : null, // для квартиры можно иначе, но пока так
    "Riga",
    "Latvia",
  ].filter(Boolean);

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