// Node 18+ предоставляет глобальный fetch — отдельный пакет не нужен.

export function buildAddressText(order) {
  // поддерживаем оба формата ключей:
  // - из БД: address_street/address_house/address_building/address_apartment
  // - из body: street/house/building/apart
  const streetRaw = String(order.address_street ?? order.street ?? "").trim();
  const house = String(order.address_house ?? order.house ?? "").trim();
  const building = String(order.address_building ?? order.building ?? "").trim();
  const apart = String(order.address_apartment ?? order.apart ?? "").trim();

  if (!streetRaw) return "";

  // Поле "улица" может содержать район через запятую, напр. "Skudru iela, Dreiliņi".
  // Разбиваем по ПЕРВОЙ запятой: до неё — улица, после — район (может быть несколько частей).
  const commaIdx = streetRaw.indexOf(",");
  const streetName =
    commaIdx >= 0 ? streetRaw.slice(0, commaIdx).trim() : streetRaw;
  const district =
    commaIdx >= 0
      ? streetRaw
          .slice(commaIdx + 1)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .join(", ")
      : "";

  // ВАЖНО: номер дома идёт СРАЗУ ПОСЛЕ названия улицы (до района),
  // иначе geoapify привяжет номер к району, а не к улице.
  // Корпус берём ТОЛЬКО из поля "building".
  const streetPart =
    house
      ? `${streetName} ${house}${building ? ` k-${building}` : ""}`
      : streetName;

  // Квартира
  const aptPart = apart ? ` dz. ${apart}` : "";

  // Собираем: "<улица> <дом>[ dz. кв][, <район>], Latvia"
  // Жёсткий "Riga" убран: район может быть вне городской черты (напр. Dreiliņi).
  const parts = [`${streetPart}${aptPart}`.trim()];
  if (district) parts.push(district);
  parts.push("Latvia");

  return parts.join(", ").trim();
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

// Обратный геокодинг: координаты → адрес (для перетаскивания маркера на карте)
export async function geoapifyReverseGeocode(lat, lng) {
  const apiKey = process.env.GEOAPIFY_KEY;
  if (!apiKey) return { ok: false, error: "GEOAPIFY_KEY missing" };

  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return { ok: false, error: "Invalid coordinates" };
  }

  const url =
    "https://api.geoapify.com/v1/geocode/reverse" +
    `?lat=${latNum}&lon=${lngNum}` +
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
  if (!item) return { ok: false, error: "No reverse geocode results" };

  return {
    ok: true,
    lat: latNum,
    lng: lngNum,
    formatted: item.formatted ?? "",
    raw: item,
  };
}