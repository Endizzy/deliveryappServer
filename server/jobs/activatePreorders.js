import pool from "../db.js";
import { rowToPanelDto, PREORDER_LEAD_HOURS } from "../currentOrder.js";

/**
 * activatePreorders(broadcastToAdmins)
 * 
 * Автоматически переводит предзаказы в активные заказы за 2 часа до их scheduled_at
 * 
 * Логика:
 * 1. SELECT предзаказы: scheduled_at <= NOW() + PREORDER_LEAD_HOURS,
 *    order_type='preorder', status NOT IN ('completed','cancelled').
 *    Условия "scheduled_at > NOW()" здесь СПЕЦИАЛЬНО нет: с ним предзаказ,
 *    время которого уже прошло (создали задним числом либо сервер простоял
 *    дольше окна), не активировался бы никогда и навсегда остался бы скрытым
 *    от курьеров.
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
        
        // ✅ ПОЛНОСТЬЮ НА SQL: SELECT только те заказы, которые нужно активировать СЕЙЧАС.
        // Берём всё, до чего осталось не больше окна, включая уже просроченное.
        // Здесь нужны только идентификаторы: полные данные для WS перечитываем
        // после UPDATE — иначе в событие уедет состояние заказа «до» активации.
        const [toActivate] = await conn.query(
            `SELECT order_id, company_id, order_no
             FROM current_orders
             WHERE order_type = 'preorder'
               AND scheduled_at IS NOT NULL
               AND status NOT IN ('completed', 'cancelled')
               AND scheduled_at <= DATE_ADD(NOW(), INTERVAL ${PREORDER_LEAD_HOURS} HOUR)
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

                    // Перечитываем заказ теми же JOIN'ами, что и список заказов.
                    // Раньше DTO собирался из строки, прочитанной ДО UPDATE, а в
                    // том SELECT'е courier_nickname и pickup_nickname были
                    // заглушками NULL — из-за этого по WS уезжал заказ без
                    // курьера и точки комплектации, и они появлялись только
                    // после перезагрузки страницы.
                    const [freshRows] = await conn.query(
                        `SELECT co.*,
                                cu1.nickname AS courier_nickname,
                                cu2.nickname AS pickup_nickname
                           FROM current_orders co
                                LEFT JOIN users cu1 ON cu1.user_id = co.courier_unit_id
                                LEFT JOIN users cu2 ON cu2.user_id = co.pickup_unit_id
                          WHERE co.order_id = ? LIMIT 1`,
                        [row.order_id]
                    );

                    if (!freshRows.length) {
                        console.warn(`[activatePreorders] ⚠️ Заказ ${row.order_id} исчез после UPDATE, WS не отправлен`);
                        continue;
                    }

                    const dto = rowToPanelDto(freshRows[0]);
                    try {
                        broadcastToAdmins({
                            type: 'order_updated',
                            companyId: row.company_id,
                            order: dto,
                            // Признак для index.js: заказ стал рабочим именно
                            // сейчас, курьеру нужно об этом сообщить. Раньше
                            // активация проходила совсем молча.
                            preorderActivated: true,
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
