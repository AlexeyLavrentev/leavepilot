# Параллельный пилот на существующем сервере

Этот runbook предназначен для переноса копии действующей установки в
изолированный пилот. Он не допускает совместного использования базы старой и
новой версиями.

Проверенная исходная точка:

- рабочий Core: дерево `fc28b7b66dbf12d20631e698291779a01bdc5661`;
- целевой Core: `v2.4.3`;
- целевой Premium: `v0.6.4`;
- действующая база: 26 Core-миграций;
- ожидается 7 новых Core-миграций и 10 Premium-миграций;
- 30 активных пользователей;
- SSO включён, поэтому действующий `CRYPTO_SECRET` обязателен.

## 1. Условия допуска

До начала работ должны быть готовы:

- согласованное окно для создания снимка базы;
- свободное место не менее трёх размеров дампа и пилотного MySQL volume;
- DNS `vacation-pilot.sdigital.local`;
- внутренний TLS-сертификат и ключ;
- Premium-лицензия минимум на 30 активных пользователей;
- Core `v2.4.3` и Premium `v0.6.4` из доверенного источника;
- утверждённое место хранения резервной копии;
- безопасный канал для переноса действующего `CRYPTO_SECRET`;
- назначенные владелец пилота и ответственный за откат.

Нельзя продолжать, если дамп не удалось восстановить в тестовую базу.

## 2. Зафиксировать состояние без изменений

В рабочем каталоге сохранить в журнал работ вывод:

```bash
docker compose ps
docker compose images
docker compose config --services
git status --short --branch
git rev-parse HEAD
docker volume ls
df -h
free -h
```

Не сохранять в журнал вывод `docker compose config`, `docker inspect` или
содержимое `.env`: там могут находиться секреты.

## 3. Создать и проверить резервную копию

Создать каталог с правами только для владельца:

```bash
install -d -m 700 /home/sdigitaladmin/backups/timeoff
```

Выполнить консистентный дамп InnoDB без остановки приложения:

```bash
umask 077
docker exec timeoff-db-1 sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqldump \
  -u"$MYSQL_USER" \
  --single-transaction \
  --routines \
  --triggers \
  --events \
  --hex-blob \
  --set-gtid-purged=OFF \
  "$MYSQL_DATABASE"' \
  | gzip -9 > /home/sdigitaladmin/backups/timeoff/timeoff-pre-pilot.sql.gz
sha256sum /home/sdigitaladmin/backups/timeoff/timeoff-pre-pilot.sql.gz \
  > /home/sdigitaladmin/backups/timeoff/timeoff-pre-pilot.sql.gz.sha256
gzip -t /home/sdigitaladmin/backups/timeoff/timeoff-pre-pilot.sql.gz
sha256sum -c /home/sdigitaladmin/backups/timeoff/timeoff-pre-pilot.sql.gz.sha256
```

Отдельно сохранить фактически используемые production-конфигурацию и env с
теми же ограничениями доступа:

```bash
tar -C /home/sdigitaladmin/timeoff -czf \
  /home/sdigitaladmin/backups/timeoff/timeoff-pre-pilot-config.tar.gz \
  .env config/app.redis.json docker-compose.yml
chmod 600 /home/sdigitaladmin/backups/timeoff/timeoff-pre-pilot-config.tar.gz
sha256sum /home/sdigitaladmin/backups/timeoff/timeoff-pre-pilot-config.tar.gz \
  > /home/sdigitaladmin/backups/timeoff/timeoff-pre-pilot-config.tar.gz.sha256
```

Архив содержит секреты: не прикладывать его к тикетам, PR и журналам работ.

Скопировать дамп во второе утверждённое хранилище. Наличие только одного файла
на том же сервере не считается резервной копией. Это относится и к архиву
конфигурации.

## 4. Подготовить отдельные исходники и секреты

Разместить Core и Premium в отдельном каталоге, не меняя рабочий checkout:

```text
/home/sdigitaladmin/timeoff-pilot/timeoff
/home/sdigitaladmin/timeoff-pilot/timeoff-premium
```

Проверить теги и чистоту деревьев:

```bash
git -C /home/sdigitaladmin/timeoff-pilot/timeoff describe --tags --exact-match
git -C /home/sdigitaladmin/timeoff-pilot/timeoff-premium describe --tags --exact-match
git -C /home/sdigitaladmin/timeoff-pilot/timeoff status --porcelain
git -C /home/sdigitaladmin/timeoff-pilot/timeoff-premium status --porcelain
```

Ожидаются `v2.4.3`, `v0.6.4` и пустой вывод обеих команд `status`.

Скопировать `.env.pilot.example` в `.env.pilot`, заполнить его через
утверждённый secret-management процесс и установить права:

```bash
chmod 600 .env.pilot
```

Требования к секретам:

- `SESSION_SECRET` — новый случайный секрет;
- `CRYPTO_SECRET` — точная копия production-секрета;
- пароли пилотной MySQL — новые и не совпадают с production;
- SMTP-реквизиты в пилот не переносятся;
- рабочий `.env` целиком не копируется.

## 5. Проверить итоговый Compose до запуска

Все дальнейшие команды выполняются из каталога пилотного Core:

```bash
pilot_compose() {
  docker compose \
    --env-file .env.pilot \
    -f docker-compose.yml \
    -f docker-compose.commercial.yml \
    -f deploy/pilot/docker-compose.pilot.yml \
    "$@"
}
```

Проверить конфигурацию, не публикуя её вывод в тикеты или чат:

```bash
pilot_compose config --quiet
pilot_compose config --services
```

Ожидаются только `db`, `redis`, `app`. Имя Compose-проекта —
`timeoff-pilot`, app публикуется только на `127.0.0.1:3001`.

## 6. Поднять хранилища и восстановить копию

```bash
pilot_compose up -d db redis
pilot_compose ps
```

После перехода MySQL и Redis в `healthy` восстановить дамп:

```bash
gunzip -c /home/sdigitaladmin/backups/timeoff/timeoff-pre-pilot.sql.gz \
  | pilot_compose exec -T db sh -c \
    'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql -u"$MYSQL_USER" "$MYSQL_DATABASE"'
```

Проверить количество миграций и агрегаты без персональных данных:

```bash
pilot_compose exec -T db sh -c \
  'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql -u"$MYSQL_USER" "$MYSQL_DATABASE" \
  -Nse "SELECT COUNT(*) FROM SequelizeMeta; SELECT COUNT(*) FROM Users; SELECT COUNT(*) FROM Leaves;"'
```

До миграции ожидаются `26`, `43`, `206`. Отклонение означает остановку работ и
разбор причины.

## 7. Собрать образ и выполнить миграции явно

Сначала собрать образ, не запуская app:

```bash
pilot_compose build app
```

Затем выполнить миграции только в пилотной базе:

```bash
pilot_compose run --rm app npm run db-update
```

При любой ошибке миграций:

1. не запускать app;
2. сохранить логи без секретов;
3. удалить только пилотную базу/volume после отдельного подтверждения;
4. восстановить исходный дамп;
5. устранить причину и повторить проверку.

Не пытаться вручную отмечать миграции выполненными.

## 8. Запустить пилот

```bash
pilot_compose up -d app
pilot_compose ps
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/
```

Ожидается healthy app и HTTP `200` либо штатный редирект `302`.

До подключения пользователей проверить, что отключены:

- email (`send_emails=false`);
- leave reminder scheduler;
- production calendar scheduler;
- Telegram digest scheduler;
- external connector scheduler;
- отдельные cron-задачи для пилотного Compose-проекта.

## 9. Подключить Nginx и TLS

Использовать `deploy/pilot/nginx.pilot.conf.example`, подставив утверждённые пути
сертификата. Перед reload обязательны:

```bash
nginx -t
curl -kIs https://vacation-pilot.sdigital.local/
```

Изменение Nginx выполняется только после отдельного согласования. Порт 3001 не
должен публиковаться за пределы loopback.

Для локального CA и установки доверия на тестовые устройства использовать
[pilot-local-ca.md](pilot-local-ca.md). Проверка должна проходить без
`-k`/`--insecure`.

## 10. Приёмочные проверки

### Данные

- 43 пользователя и 206 отпусков присутствуют;
- активных пользователей 30;
- подразделения, типы отпусков и праздничные дни совпадают;
- остатки и история заявок доступны;
- нет изменений в production-базе.

### Доступ и SSO

- локальный администратор может войти;
- SSO metadata/config читаются без ошибки расшифрования;
- тестовый SSO-вход работает с отдельным callback URL;
- auto-provisioning не создаёт нежелательных пользователей;
- logout и срок жизни сессии работают через HTTPS.

Изменение callback URL в корпоративном IdP требует отдельного согласования. До
этого SSO-проверка может быть ограничена чтением конфигурации.

### Функциональность

- сотрудник видит остаток и календарь;
- заявка создаётся и отменяется только на пилотной копии;
- руководитель согласует и отклоняет тестовую заявку;
- заместители, конфликты и планы отпусков отображаются;
- производственный календарь RU корректен;
- Premium-лицензия показывает ожидаемый лимит мест;
- email, Telegram и коннекторы ничего не отправляют наружу.

### Наблюдаемость

- в логах нет migration, decrypt, license и Redis errors;
- контейнеры не перезапускаются;
- память и диск проверяются до и после теста;
- старое приложение продолжает отвечать на порту 3000.

## 11. Остановка и откат пилота

Остановка пилота не затрагивает production:

```bash
pilot_compose stop app
```

Для остановки всего пилотного стека с сохранением данных:

```bash
pilot_compose down
```

Не использовать `down -v`: удаление пилотных томов является отдельной
деструктивной операцией и требует подтверждения.

Production rollback не требуется, поскольку production-контейнеры, база,
тома, cron и Nginx-маршрут не изменяются до отдельного этапа переключения.

## 12. Критерии допуска к будущему переключению

- резервная копия восстановлена минимум один раз;
- пилот стабилен не менее согласованного периода;
- SSO и основные пользовательские сценарии приняты;
- SMTP/Telegram/коннекторы протестированы контролируемо;
- подготовлены production TLS, backup schedule и мониторинг;
- закрыт прямой внешний доступ к порту 3000;
- секреты перенесены из group-readable файлов и скомпрометированные значения
  заменены;
- согласованы maintenance window и отдельный production rollback plan.
