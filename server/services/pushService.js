

import pool from "../db.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// ── Сохранить/обновить токен курьера (upsert по token) ──────────────────────
export async function savePushToken({ unitId, companyId, token, platform }) {
    await pool.query(
        `INSERT INTO courier_push_tokens (unit_id, company_id, token, platform)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            unit_id = VALUES(unit_id),
            company_id = VALUES(company_id),
            platform = VALUES(platform),
            updated_at = CURRENT_TIMESTAMP`,
        [unitId, companyId, token, platform || null]
    );
}

export async function deletePushTokensByValue(tokens) {
    if (!tokens || tokens.length === 0) return;
    const placeholders = tokens.map(() => "?").join(",");
    await pool.query(`DELETE FROM courier_push_tokens WHERE token IN (${placeholders})`, tokens);
}

export async function deletePushTokensByUnit(unitId) {
    if (unitId == null) return;
    await pool.query(`DELETE FROM courier_push_tokens WHERE unit_id = ?`, [unitId]);
}

async function getCompanyCourierTokens(companyId, excludeUnitId, onlyUnitId) {
    const params = [companyId];
    let sql = `SELECT token FROM courier_push_tokens WHERE company_id = ?`;
    // Адресная отправка: заказ, назначенный конкретному курьеру, остальным
    // не нужен — они его всё равно не могут взять.
    if (onlyUnitId != null) {
        sql += ` AND unit_id = ?`;
        params.push(onlyUnitId);
    } else if (excludeUnitId != null) {
        sql += ` AND unit_id <> ?`;
        params.push(excludeUnitId);
    }
    const [rows] = await pool.query(sql, params);
    return rows.map((r) => r.token);
}

function isExpoToken(t) {
    return typeof t === "string" &&
        (t.startsWith("ExponentPushToken[") || t.startsWith("ExpoPushToken["));
}

function buildOrderMessage(order, { assigned = false } = {}) {
    const orderNo = order?.orderSeq ?? order?.orderNo ?? order?.order_no ?? order?.id ?? "";
    const address = order?.address || order?.addressStreet || "";
    const amount =
        order?.amountTotal != null ? `${order.amountTotal} €` :
        order?.amount_total != null ? `${order.amount_total} €` : "";
    const parts = [orderNo ? `№${orderNo}` : "", address, amount].filter(Boolean);
    return {
        // Назначенный заказ требует другого действия, чем свободный:
        // его не нужно «успевать взять», он уже за курьером.
        title: assigned ? "Вам назначен заказ" : "Новый заказ",
        body: parts.length ? parts.join(" · ") : (assigned ? "Заказ назначен вам" : "Поступил новый заказ"),
    };
}

// ── Отправить push о новом заказе ───────────────────────────────────────────
// Заказ уже назначен курьеру → уведомляем только его: остальным он не нужен,
// взять они его не могут, а лишний push уводил их на страницу точки, где
// этого заказа нет. Свободный заказ по-прежнему уходит всем курьерам компании.
export async function sendOrderPush(companyId, order, opts = {}) {
    try {
        if (typeof companyId !== "number") return;

        const assignedTo = order?.courierId ?? order?.courier_unit_id ?? null;
        const onlyUnitId = opts.onlyUnitId ?? assignedTo ?? null;

        const allTokens = await getCompanyCourierTokens(companyId, opts.excludeUnitId, onlyUnitId);
        const tokens = allTokens.filter(isExpoToken);
        console.log(
            `[push] sendOrderPush company=${companyId} order=${order?.id ?? '?'} ` +
            `${onlyUnitId != null ? `→ курьеру ${onlyUnitId}` : '→ всем курьерам'}: ` +
            `${allTokens.length} rows, ${tokens.length} valid tokens`
        );
        if (tokens.length === 0) return;

        const { title, body } = buildOrderMessage(order, { assigned: onlyUnitId != null });

        const messages = tokens.map((token) => ({
            to: token,
            sound: "default",
            priority: "high",
            channelId: "orders",
            title,
            body,
            data: {
                type: "order_created",
                orderId: order?.id ?? order?.order_id ?? null,
                companyId,
                // Подсказки для навигации по тапу: приложение решает, куда вести
                // курьера, ещё до загрузки списков (важно при холодном старте).
                courierId: order?.courierId ?? order?.courier_unit_id ?? null,
                outlet: order?.outlet ?? order?.pickupName ?? order?.pickup_nickname ?? null,
            },
        }));

        const invalid = [];
        // Expo принимает до 100 сообщений за запрос
        for (let i = 0; i < messages.length; i += 100) {
            const chunk = messages.slice(i, i + 100);
            try {
                const res = await fetch(EXPO_PUSH_URL, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "application/json",
                    },
                    body: JSON.stringify(chunk),
                });
                const json = await res.json().catch(() => null);
                console.log("[push] Expo response:", JSON.stringify(json));
                const data = json?.data;
                if (Array.isArray(data)) {
                    data.forEach((ticket, idx) => {
                        if (ticket?.status === "error" &&
                            ticket?.details?.error === "DeviceNotRegistered") {
                            invalid.push(chunk[idx].to);
                        }
                    });
                }
            } catch (e) {
                console.error("[push] send chunk error:", e?.message ?? e);
            }
        }

        // Чистим «мёртвые» токены
        if (invalid.length) {
            await deletePushTokensByValue(invalid).catch(() => {});
        }
    } catch (e) {
        console.error("[push] sendOrderPush error:", e?.message ?? e);
    }
}
