import pool from "../db.js";
import { rowToPanelDto } from "../currentOrder.js";

/**
 * activatePreorders(broadcastToAdmins)
 * 
 * Автоматически переводит предзаказы в активные заказы за 2 часа до scheduled_at
 * 
 * Логика:
 * 1. SELECT предзаказы: scheduled_at <= NOW() + 2 HOUR, order_type='preorder', status NOT IN ('completed','cancelled')
 * 2. UPDATE каждого: order_type='active', в защищённой транзакции
 * 3. broadcastToAdmins для каждого переведённого заказа
 * 4. Логирование результатов
 * 
 */
export async function activatePreorders(broadcastToAdmins) {
    const conn = await pool.getConnection();
    try {
        // SELECT предзаказов, которые нужно активировать
        // Условие: scheduled_at <= NOW() + 2 HOUR
        const [preorders] = await conn.query(
            `SELECT 
                order_id, company_id, customer_name, customer_phone, order_no,
                order_seq, order_seq_date, address_street, address_house,
                address_building, address_apartment, address_floor, address_code,
                address_lat, address_lng, geocoded_at, geocode_provider,
                status, order_type, payment_method, people_amount, delivery_fee,
                amount_total, amount_subtotal, amount_discount, items_json,
                created_at, updated_at, scheduled_at,
                courier_unit_id, courier_nickname, dispatcher_unit_id, pickup_unit_id, pickup_nickname
             FROM current_orders
             WHERE order_type = 'preorder'
               AND scheduled_at IS NOT NULL
               AND scheduled_at <= DATE_ADD(NOW(), INTERVAL 2 HOUR)
               AND status NOT IN ('completed', 'cancelled')
             ORDER BY scheduled_at ASC`,
            []
        );

        if (!preorders || preorders.length === 0) {
            console.log(`[activatePreorders] Нет предзаказов к активации`);
            return;
        }

        console.log(`[activatePreorders] Найдено ${preorders.length} предзаказов к активации`);

        // Обработка каждого заказа
        const results = {
            success: 0,
            errors: [],
        };

        for (const row of preorders) {
            try {
                // Защита от двойного срабатывания: проверяем статус перед UPDATE
                const [checkRows] = await conn.query(
                    `SELECT order_id, order_type FROM current_orders WHERE order_id = ? LIMIT 1`,
                    [row.order_id]
                );

                if (!checkRows || checkRows.length === 0) {
                    console.warn(`[activatePreorders] Заказ ${row.order_id} не найден (удалён?)`);
                    continue;
                }

                const orderRecord = checkRows[0];
                
                // Если уже активирован, пропускаем
                if (orderRecord.order_type !== 'preorder') {
                    console.log(`[activatePreorders] Заказ ${row.order_id} уже активирован, пропускаем`);
                    continue;
                }

                // UPDATE: переводим в активные
                const [updateResult] = await conn.query(
                    `UPDATE current_orders 
                     SET order_type = 'active', updated_at = NOW()
                     WHERE order_id = ? AND order_type = 'preorder'`,
                    [row.order_id]
                );

                if (updateResult.affectedRows > 0) {
                    console.log(`[activatePreorders] Заказ ${row.order_id} (${row.order_no}) активирован`);
                    results.success++;

                    // Отправляем broadcastToAdmins с обновлённым заказом
                    const dto = rowToPanelDto(row);
                    try {
                        broadcastToAdmins({
                            type: 'order_updated',
                            companyId: row.company_id,
                            order: { ...dto, orderType: 'active' },
                        });
                    } catch (wsErr) {
                        console.error(
                            `[activatePreorders] Ошибка при отправке WS для заказа ${row.order_id}:`,
                            wsErr?.message ?? wsErr
                        );
                    }
                } else {
                    console.log(`[activatePreorders] Заказ ${row.order_id} не был обновлён (условие не выполнено)`);
                }
            } catch (err) {
                const errMsg = err?.message ?? String(err);
                console.error(`[activatePreorders] Ошибка при обработке заказа ${row.order_id}: ${errMsg}`);
                results.errors.push({
                    orderId: row.order_id,
                    error: errMsg,
                });
            }
        }

        console.log(
            `[activatePreorders] Завершено. Успешно: ${results.success}, Ошибок: ${results.errors.length}`
        );
        if (results.errors.length > 0) {
            console.log(`[activatePreorders] Ошибки:`, results.errors);
        }
    } catch (err) {
        console.error(
            `[activatePreorders] Критическая ошибка при получении предзаказов:`,
            err?.message ?? err
        );
    } finally {
        await conn.release();
    }
}
