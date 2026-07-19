# Миграция: единая таблица `users` для всех логинов

Цель: убрать вторую таблицу идентичности `company_units`. Все, кто логинится
(owner, admin, courier, client), живут в `users`. Заказы и push-токены
ссылаются на `users.user_id`. Пункт выдачи / курьер — это роль в `users`.

## 1. Итоговая модель

`users` — единственная таблица аутентификации:
- существующее: user_id, first_name, last_name, nickname, is_active, last_enter,
  email, phone, password, totp_secret, totp_enabled, role, company_id, timestamps
- `role` enum расширяем/используем: `owner | admin | courier | client`
- ДОБАВИТЬ: `color varchar(16) NULL` (цвет курьера на карте)
- `email` делаем NULLABLE (у курьеров может не быть email; уникальность и так
  проверяется в коде, DB-констрейнта на email нет)

`company_units` — удаляется после переноса (сначала оставим как архив
`company_units_bak`, дропнем после проверки).

`current_orders`:
- `courier_unit_id`, `pickup_unit_id`, `dispatcher_unit_id` теперь хранят
  `users.user_id`. **Решение:** имена колонок НЕ меняем (минимум правок в SQL),
  но по смыслу это теперь ссылки на users. (Опция: переименовать в
  `*_user_id` — чище, но больше правок. По умолчанию — оставляем имена.)

`courier_push_tokens.unit_id` — теперь `users.user_id`.

## 2. SQL-миграция (порядок важен)

```sql
-- 2.1 Расширяем users
ALTER TABLE users MODIFY email varchar(255) NULL;
ALTER TABLE users ADD COLUMN color varchar(16) NULL AFTER role;
-- временная колонка для маппинга старый unit_id -> новый user_id
ALTER TABLE users ADD COLUMN _legacy_unit_id bigint NULL;

-- 2.2 Переносим company_units -> users
-- first_name = ник (last_name пустой, т.к. NOT NULL), пароль/роль/актив как есть
INSERT INTO users
  (first_name, last_name, nickname, is_active, last_enter,
   email, phone, password, role, color, company_id,
   created_at, updated_at, _legacy_unit_id)
SELECT
  cu.unit_nickname, '', cu.unit_nickname, cu.is_active, cu.unit_last_enter,
  cu.unit_email, cu.unit_phone, cu.unit_password_hash, cu.unit_role, cu.color,
  cu.company_id, cu.created_at, cu.updated_at, cu.unit_id
FROM company_units cu;

-- 2.3 Репойнтим заказы (courier / pickup / dispatcher)
UPDATE current_orders o
  JOIN users u ON u._legacy_unit_id = o.courier_unit_id
  SET o.courier_unit_id = u.user_id
  WHERE o.courier_unit_id IS NOT NULL;

UPDATE current_orders o
  JOIN users u ON u._legacy_unit_id = o.pickup_unit_id
  SET o.pickup_unit_id = u.user_id
  WHERE o.pickup_unit_id IS NOT NULL;

UPDATE current_orders o
  JOIN users u ON u._legacy_unit_id = o.dispatcher_unit_id
  SET o.dispatcher_unit_id = u.user_id
  WHERE o.dispatcher_unit_id IS NOT NULL;

-- 2.4 Репойнтим push-токены
UPDATE courier_push_tokens t
  JOIN users u ON u._legacy_unit_id = t.unit_id
  SET t.unit_id = u.user_id;

-- 2.5 Архивируем и убираем временное
RENAME TABLE company_units TO company_units_bak;
ALTER TABLE users DROP COLUMN _legacy_unit_id;
-- company_units_bak дропнуть вручную после проверки боем
```

> Данных мало (≈13 users, ≈19 units, ≈188 orders) — миграция мгновенная.
> Делать в момент низкой нагрузки; сделать дамп ПЕРЕД запуском.

## 3. Изменения на сервере

- **auth.js**
  - `courierlogin`: запрос к `users` (role='courier', is_active) по email/phone
    (или nickname — см. решение ниже). Токен-claim оставляем прежним
    `{ userId: user.user_id, role, companyId, unitNickname: nickname }` — мобилка
    не заметит разницы.
  - `login` (веб): уже к `users`. Добавить запрет входа для role='courier'
    (курьерам веб-клиент недоступен). owner/admin/client — пропускаем.
  - Починить существующий баг приоритета `OR/AND` в courierlogin.
- **companyUnits.js** → переписать CRUD персонала на `users`
  (INSERT/UPDATE/SELECT users где role in ('admin','courier') AND company_id=?).
  `ensureColorColumn` больше не нужен (color в users).
- **orderSupport.js** — `getCouriers` (users role='courier'),
  `getPickupPoints` (users role='admin'), оба по company_id.
- **currentOrder.js / mobileOrdersRouter.js** — логика та же (колонки те же
  имена), проверить что везде company_id-скоуп; dispatcher = req.user.userId.
- **pushService.js** — `unit_id` теперь user_id (значение то же в токене).
- **index.js** — staff-роуты (`/api/staff`) остаются, но бьют по users.

## 4. Мобильное приложение (courier-app)

- Логин: тело `courierlogin` и поля токена не меняются → в идеале правок нет.
- Если решим логинить курьера по nickname — поправить LoginScreen (поле ввода).
- WS `courierId`, push-регистрация — используют `userId` из токена, значение
  теперь user_id, но семантика та же. Пересборка/OTA обязательна для проверки.

## 5. Веб-клиент

- OwnerSettings staff CRUD — тот же API `/api/staff`, ответы совместимы
  (id, nickname, role, color). Возможны мелкие правки полей.
- Логин админа — та же страница, тот же `/api/auth/login`. Заработает само,
  как только админ окажется в `users`.

## 6. Решения, которые надо подтвердить

1. **Как курьер логинится?** Сейчас — email ИЛИ телефон. Варианты:
   (а) оставить email/phone; (б) по нику + компания. Рекомендую (а) — 0 правок
   в мобилке. Тогда при создании курьера желателен уникальный email или телефон.
2. **Имена колонок заказов** — оставить `*_unit_id` (по умолчанию) или
   переименовать в `*_user_id` (чище, +правки).
3. **role='admin' vs пункт выдачи** — админ остаётся и логином, и пунктом
   выдачи (pickup_unit_id → users.user_id роли admin). Оставляем как есть.

## 7. Порядок выката (чтобы ничего не легло)

1. Бэкап БД (дамп).
2. Прогнать SQL-миграцию (раздел 2).
3. Задеплоить сервер с обновлённым кодом (auth/companyUnits/orderSupport).
4. Пересобрать/OTA мобильное приложение, проверить вход курьера + карту + заказы.
5. Проверить вход админа на веб-клиенте.
6. Убедиться, что всё ок → дропнуть `company_units_bak`.

## 8. Откат

- Код: откатить деплой сервера/мобилки.
- Данные: `company_units_bak` цел; при необходимости восстановить обратными
  UPDATE по сохранённому маппингу (перед дропом временной колонки снять
  `SELECT user_id, _legacy_unit_id FROM users WHERE _legacy_unit_id IS NOT NULL`).
```
```
