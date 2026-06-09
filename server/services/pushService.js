// services/pushService.js
// Push-уведомления курьерам через Expo Push API (поверх FCM).
// Дополняет WebSocket: WS — для живых обновлений при открытом приложении,
// push — чтобы «разбудить» курьера, когда приложение свёрнуто или закрыто.

import pool from "../db.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// ── Таблица токенов (idempotent, создаётся при старте сервера) ───────────────
export async function ensurePushTokenTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS courier_push_tokens (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            unit_id     INT NOT NULL,
            company_id  INT NOT NULL,
            token       VARCHAR(255) NOT NULL,
            platform    VARCHAR(16)  DEFAULT NULL,
            updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_token (token),
            KEY idx_company (company_id),
            KEY idx_unit (unit_id)
        )
    `);
}

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

async function getCompanyCourierTokens(companyId, excludeUnitId) {
    const params = [companyId];
    let sql = `SELECT token FROM courier_push_tokens WHERE company_id = ?`;
    if (excludeUnitId != null) {
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

function buildOrderMessage(order) {
    const orderNo = order?.orderSeq ?? order?.orderNo ?? order?.order_no ?? order?.id ?? "";
    const address = order?.address || order?.addressStreet || "";
    const amount =
        order?.amountTotal != null ? `${order.amountTotal} €` :
        order?.amount_total != null ? `${order.amount_total} €` : "";
    const parts = [orderNo ? `№${orderNo}` : "", address, amount].filter(Boolean);
    return {
        title: "Новый заказ",
        body: parts.length ? parts.join(" · ") : "Поступил новый заказ",
    };
}

// ── Отправить push о новом заказе всем курьерам компании ────────────────────
export async function sendOrderPush(companyId, order, opts = {}) {
    try {
        if (typeof companyId !== "number") return;

        const allTokens = await getCompanyCourierTokens(companyId, opts.excludeUnitId);
        const tokens = allTokens.filter(isExpoToken);
        if (tokens.length === 0) return;

        const { title, body } = buildOrderMessage(order);

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
