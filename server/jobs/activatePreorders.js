import pool from "../db.js";
import { rowToPanelDto } from "../currentOrder.js";

/**
 * activatePreorders(broadcastToAdmins)
 * 
 * Автоматически переводит предзаказы в активные заказы за 2 часа до их scheduled_at
 * 
 * Логика:
 * 1. SELECT предзаказы: scheduled_at > NOW() (ещё не наступили) И 
 *    scheduled_at <= NOW() + 2 HOUR (до них осталось ≤ 2 часа),
 *    order_type='preorder', status NOT IN ('completed','cancelled')
 * 2. UPDATE каждого: order_type='active', в защищённой транзакции
 * 3. broadcastToAdmins для каждого переведённого заказа
 * 4. Логирование результатов
 * 
 */
export async function activatePreorders(broadcastToAdmins) {
    const startTime = new Date();
    console.log(`[activatePreorders] ⏱️ Запуск в ${startTime.toISOString()}`);
    
    let conn;
    try {
        conn = await pool.getConnection();
        
        // DEBUG: Проверим текущее время БД
        const [[{ db_now }]] = await conn.query(`SELECT NOW() as db_now`);
        console.log(`[activatePreorders] 🕐 Время БД: ${db_now}`);
        
        // ✅ ПОЛНОСТЬЮ НА SQL: SELECT только те заказы, которые нужно активировать СЕЙЧАС
        // Условие: scheduled_at > NOW() (ещё не наступили) И 
        //          scheduled_at <= NOW() + 2 HOUR (до них осталось ≤ 2 часа)
        const [toActivate] = await conn.query(
            `SELECT 
                order_id, company_id, customer_name, customer_phone, order_no,
                order_seq, order_seq_date, address_street, address_house,
                address_building, address_apartment, address_floor, address_code,
                address_lat, address_lng, geocoded_at, geocode_provider,
                status, order_type, payment_method, people_amount, delivery_fee,
                amount_total, amount_subtotal, amount_discount, items_json,
                created_at, updated_at, scheduled_at,
                courier_unit_id, dispatcher_unit_id, pickup_unit_id,
                NULL AS courier_nickname, NULL AS pickup_nickname
             FROM current_orders
             WHERE order_type = 'preorder'
               AND scheduled_at IS NOT NULL
               AND status NOT IN ('completed', 'cancelled')
               AND scheduled_at > NOW()
               AND scheduled_at <= DATE_ADD(NOW(), INTERVAL 2 HOUR)
             ORDER BY scheduled_at ASC
             LIMIT 100`,
            []
        );

        if (!toActivate || toActivate.length === 0) {
            console.log(`[activatePreorders] ✅ Нет предзаказов к активации в этот момент`);
            return;
        }

        console.log(`[activatePreorders] 🔄 К активации: ${toActivate.length}`);

        // Обработка каждого заказа
        const results = {
            success: 0,
            errors: [],
        };

        for (const row of toActivate) {
            try {
                // Защита от двойного срабатывания: проверяем статус перед UPDATE
                const [checkRows] = await conn.query(
                    `SELECT order_id, order_type FROM current_orders WHERE order_id = ? LIMIT 1`,
                    [row.order_id]
                );

                if (!checkRows || checkRows.length === 0) {
                    console.warn(`[activatePreorders] ❌ Заказ ${row.order_id} не найден (удалён?)`);
                    continue;
                }

                const orderRecord = checkRows[0];
                
                // Если уже активирован, пропускаем
                if (orderRecord.order_type !== 'preorder') {
                    console.log(`[activatePreorders] ⏭️ Заказ ${row.order_id} уже активирован, пропускаем`);
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
                    console.log(`[activatePreorders] ✅ Заказ ${row.order_id} (${row.order_no}) активирован`);
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
                            `[activatePreorders] ⚠️ Ошибка при отправке WS для заказа ${row.order_id}:`,
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
            `[activatePreorders] ✨ Завершено. Успешно: ${results.success}, Ошибок: ${results.errors.length}`
        );
        if (results.errors.length > 0) {
            console.log(`[activatePreorders] ❌ Ошибки:`, results.errors);
        }
        
        const duration = (new Date() - startTime);
        console.log(`[activatePreorders] ⏱️ Время выполнения: ${duration}ms`);
    } catch (err) {
        console.error(
            `[activatePreorders] 💥 Критическая ошибка:`,
            err?.message ?? err
        );
    } finally {
        if (conn) {
            try {
                await conn.release();
            } catch (e) {
                console.error(`[activatePreorders] ❌ Ошибка при закрытии соединения:`, e?.message ?? e);
            }
        }
    }
}
