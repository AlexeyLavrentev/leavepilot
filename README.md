# LeavePilot

Source-available leave management system for teams and growing businesses. Handles vacations, sick days, time-off requests, and other employee absences.

- Quick local setup for evaluation and testing
- Deploy as an internal company service
- Run with MySQL and Redis via `docker compose`
- Connect LDAP authentication
- Premium: OIDC/SAML SSO and additional modules

## Features

- Calendar and table views for absences
- Employee, manager, and administrator roles
- Leave request approval workflow
- Multiple absence types
- CSV export and reports
- Calendar integration (iCal feed)
- Interface localization
- LDAP authentication

## Community and Premium

Community is a fully functional leave management application. Premium adds enterprise features and requires a private premium module and a signed license in production.

| Feature | Community | Premium |
|---|---:|---:|
| Core leave management | yes | yes |
| Employee, manager, admin roles | yes | yes |
| Leave request approval | yes | yes |
| CSV export and reports | yes | yes |
| LDAP | yes | yes |
| Leave start reminders | yes | yes |
| OIDC/SAML SSO | no | yes |
| Employee groups | no | yes |
| Work calendars | no | yes |
| Integration API | no | yes |
| Time balance | no | yes |
| Vacation planning | no | yes |

Launch modes and licensing rules are described in
[docs/community-commercial-builds.md](docs/community-commercial-builds.md).

## Choosing an installation method

| Scenario | Recommended method |
|---|---|
| Try the app on a single machine | `npm` + `SQLite` |
| Development without Docker | `npm` + `SQLite` or external `MySQL` |
| Corporate pilot / internal server | `docker compose` |
| Need MySQL and Redis out of the box | `docker compose` |

For the simplest setup, start with `npm` + `SQLite`.
For a configuration close to a production corporate environment, use `docker compose`.

## Prerequisites

### npm installation

- `Node.js 22` (range from `package.json`: `>=22.12.0 <23`)
- `npm`

### Docker installation

- `Docker`
- `Docker Compose` plugin (`docker compose`)

## Configuration before first launch

### 1. `.env` file

Required for `docker compose`.

```bash
cp .env.example .env
```

At minimum, replace:

- `SESSION_SECRET`
- `CRYPTO_SECRET`
- `MYSQL_PASSWORD`
- `MYSQL_ROOT_PASSWORD`
- `SESSION_COOKIE_SECURE` -- set to `true` if TLS is terminated by a proxy
  in front of the app. Defaults to `false`.

Optional overrides:

- `APP_PORT`
- `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- `TRUST_PROXY`
- `SESSION_COOKIE_SAME_SITE`

### 2. `config/app.json`

Edit this file when running the app directly via `npm`.

Common settings:

- `application_domain` -- the URL visible to users
- `default_language` and `supported_languages`
- `allow_create_new_accounts` -- whether self-registration is allowed
- `send_emails` and `email_transporter` -- for real email notifications
- `sessionStore.useRedis` and `sessionStore.redisConnectionConfiguration` -- for Redis with npm

### 3. `config/app.redis.json`

Edit this file when running via `docker compose`. This file is mounted into the container as the main `config/app.json`.

Common settings:

- `application_domain`
- `default_language` and `supported_languages`
- `send_emails` and `email_transporter`
- `allow_create_new_accounts` -- defaults to `false`
- `sessionStore.redisConnectionConfiguration`

## Quick start 1: npm + SQLite

The simplest way to try the app locally.

### Step 1. Install dependencies

```bash
npm install
```

### Step 2. Run migrations

```bash
npm run db-update
```

### Step 3. Start the application

```bash
npm start
```

### Leave start reminders

After enabling reminder notifications in department settings, send reminders manually:

```bash
npm run send-upcoming-leave-reminders
```

By default, the command finds approved leaves starting in 14 days and sends emails without duplicates.

For automatic scheduling inside the app:

```bash
LEAVE_REMINDER_SCHEDULER_ENABLED=true
LEAVE_REMINDER_SCHEDULER_TIME=09:00
LEAVE_REMINDER_SCHEDULER_TIMEZONE=UTC
```

### Premium external connectors

The built-in external connector scheduler is disabled by default. For daily sync:

```bash
EXTERNAL_CONNECTORS_SCHEDULER_ENABLED=true
EXTERNAL_CONNECTORS_SCHEDULER_TIME=08:00
EXTERNAL_CONNECTORS_SCHEDULER_TIMEZONE=Asia/Yekaterinburg
```

Jira Data Center is often on an internal network. Allow specific hosts or IPs:

```bash
JIRA_DC_PRIVATE_HOST_ALLOWLIST=jira.internal.example,10.20.30.40
```

Do not add loopback, metadata, or link-local addresses to the allowlist.

### Step 4. Open the application

```
http://localhost:3000
```

### What happens in this mode

- SQLite is used by default
- Database file: `db.development.sqlite`
- Sessions are stored in the database, not Redis
- Development secrets are applied automatically if not set manually

### Creating the first administrator

The simplest way:

```bash
npm run create-admin -- --email admin@example.com --company "My Company"
```

The command creates a company and administrator. If `--password` is not provided, a random password is shown once in the terminal.

Additional options: `--country RU|KZ|...`, `--timezone Europe/Moscow`, `--name`, `--lastname`.

Alternative: self-registration is enabled by default in this mode. Open `/register/` and register a company -- the first user automatically becomes an administrator.

Detailed instructions: [docs/install-local-npm.md](docs/install-local-npm.md)

### Demo: populated product in one command

The fastest way to see a working product:

```bash
npm run demo
```

This starts a local instance populated with demo data: a company, 4 departments, 12 employees, and leave requests (approved and pending).

Demo secrets are set automatically. For real deployments, set your own secrets.

```
http://localhost:3001
```

Login:

```
Email:    demo-admin@leavepilot.local
Password: DemoLeavePilot1!
```

Remove the demo:

```bash
docker compose -f docker-compose.demo.yml down -v
```

Screenshots are generated by `npm run screenshots`.

To seed demo data into an existing development installation:

```bash
npm run seed-demo
```

## Quick start 2: npm + external MySQL and Redis

For development without Docker but with real services.

### Before starting

1. Set up your MySQL instance
2. Set up your Redis instance
3. Edit `config/app.json`:
   - Set `sessionStore.useRedis: true`
   - Configure the Redis address
4. Set database environment variables

Example:

```bash
export DB_DIALECT=mysql
export DB_HOST=127.0.0.1
export DB_PORT=3306
export DB_NAME=timeoff
export DB_USER=timeoff
export DB_PASSWORD=strong_password
export SESSION_SECRET=replace-me
export CRYPTO_SECRET=replace-me
```

### Then

```bash
npm install
npm run db-update
npm start
```

## Quick start 3: Docker Compose

Recommended for pilots, internal servers, and near-production setups.

### Step 1. Prepare `.env`

```bash
cp .env.example .env
```

Replace secrets and passwords.

### Step 2. Edit `config/app.redis.json` if needed

Common changes: `application_domain`, email settings, interface languages, registration policy.

### Step 3. Start services

```bash
docker compose up --build -d
```

### Step 4. Run migrations

```bash
docker compose run --rm app npm run db-update
```

### Step 5. Open the application

```
http://localhost:3000
```

Or `http://localhost:<APP_PORT>` if you changed the port in `.env`.

### Creating the first administrator in compose

```bash
docker compose exec app npm run create-admin -- --email admin@example.com --company "My Company"
```

`allow_create_new_accounts` remains `false` -- public registration is not opened.

Detailed instructions: [docs/docker-compose.md](docs/docker-compose.md)

## Verifying the application works

### Quick manual check

1. Login page opens
2. No `500 Internal Server Error`
3. After login, calendar and settings are accessible

### Container check

```bash
docker compose ps
```

Expected: `app`, `db`, `redis` are `running` or `healthy`.

### HTTP response check

```bash
curl -I http://localhost:3000
```

## Verifying MySQL is used (not SQLite)

### In Docker Compose

```bash
docker compose exec app node -e "const db=require('./lib/model/db'); console.log({dialect: db.sequelize.getDialect(), host: db.sequelize.config.host, database: db.sequelize.config.database}); db.sequelize.close();"
```

Expected: `dialect: 'mysql'`, `host: 'db'` or your MySQL host.

### In local npm setup

```bash
node -e "const db=require('./lib/model/db'); console.log({dialect: db.sequelize.getDialect(), host: db.sequelize.config.host, storage: db.sequelize.options.storage}); db.sequelize.close();"
```

## Verifying Redis is connected

### Check Redis itself

```bash
docker compose exec app node -e "const redis=require('redis'); const c=redis.createClient({url: 'redis://redis:6379', RESP: 2}); c.connect().then(() => c.ping()).then(r => { console.log(r); c.quit(); }).catch(e => { console.error(e.message); process.exit(1); });"
```

Expected: `PONG`

### Check sessions in Redis

```bash
docker compose exec app node -e "const redis=require('redis'); const c=redis.createClient({url: 'redis://redis:6379', RESP: 2}); c.connect().then(() => c.keys('sess:*')).then(r => { console.log(r.join('\n')); c.quit(); }).catch(e => { console.error(e.message); process.exit(1); });"
```

### Check application logs

```bash
docker compose logs app
```

Look for: `Connected to redis successfully`

Note: Redis is not used by default with `npm`. Enable it in `config/app.json` if needed.

## Testing the application

### Quick manual smoke test

- Open the login page
- Log in as administrator
- Create an employee
- Create an absence type
- Submit a leave request
- Verify calendar and list display correctly

### Automated tests

```bash
npm test
```

## Updating an existing installation

### npm

```bash
git fetch
git pull
npm install
npm run db-update
npm start
```

### Docker Compose

```bash
git fetch
git pull
docker compose up --build -d
docker compose run --rm app npm run db-update
```

Migrations must not be skipped: new code may expect an updated database schema.

## Community Docker image

Multi-platform image published to GitHub Container Registry:

```
ghcr.io/alexeylavrentev/leavepilot-community
```

Pin the full image version for production. Instructions: [docs/container-images.md](docs/container-images.md).

## Secret encryption at rest

Secrets stored in the database are encrypted with AES-256-GCM (authenticated encryption). Currently this covers the **OIDC client secret** in `Companies.sso_auth_config`.

Storage format (versioned): `enc:v1:aes-256-gcm:<iv>:<tag>:<ciphertext>` (parts in base64).

### Encryption key

Derived (SHA-256, with domain separation) from:

- `TIMEOFF_SECRET_KEY` -- optional dedicated variable; if not set,
- `CRYPTO_SECRET` is used.

### Backward compatibility

- Existing plaintext values continue to be read; on next save they are overwritten encrypted.
- Migration `20260627130000-encrypt-sso-client-secret.js` encrypts already-stored plaintext secrets.
- The client secret field in the UI is no longer pre-filled: an empty field on save means "keep current secret", not "clear".

### Operational warnings

- **Losing the key makes encrypted secrets unrecoverable.** Treat `CRYPTO_SECRET` / `TIMEOFF_SECRET_KEY` as a backup-critical secret.
- **Backup/restore:** a database dump is only useful with the same key.
- **Key rotation is not implemented.** Changing the key invalidates previously encrypted secrets.

## FAQ

### Can I start with SQLite and migrate to MySQL later?

Yes, but this is not an automatic data migration. Data and schema must be migrated separately.

### Do I need to edit `.env` for npm?

No. Development mode uses safe fallback secrets. For real deployments, set your own values.

### What port is used?

- Local `npm start`: `3000` unless `PORT` is set
- `docker compose`: container listens on `3000`, published as `${APP_PORT:-3000}`

### Why does Docker use `config/app.redis.json` instead of `config/app.json`?

Compose mounts the config with Redis session storage enabled.

### Where are the SSO instructions?

[docs/sso-keycloak.md](docs/sso-keycloak.md)

## Documentation map

- [Local npm installation](docs/install-local-npm.md)
- [Docker Compose setup](docs/docker-compose.md)
- [Verification, troubleshooting](docs/verification-and-troubleshooting.md)
- [User and admin FAQ](docs/faq.md)
- [Redis session store](docs/SessionStoreInRedis.md)
- [SSO via Keycloak](docs/sso-keycloak.md)
- [Licensing architecture](docs/licensing-architecture.md)
- [License operations](docs/license-operations.md)
- [License Portal](docs/license-portal.md)
- [Operator backup checklist](docs/operator-backup-checklist.md)
- [License key compromise](docs/license-key-compromise.md)

## Licensing

### Community Edition

LeavePilot Community Edition is distributed under the Elastic License 2.0
(SPX: `Elastic-2.0`).

You may:
- Deploy the system for your own use, including commercial use within your organization
- Modify the source code
- Distribute your modifications

You may not provide the system to third parties as a hosted or managed service
that gives users access to a substantial portion of the system's capabilities.

Full license text: [LICENSE.md](LICENSE.md). Boundary analysis with examples:
[docs/licensing-faq.md](docs/licensing-faq.md). Licensing history and upstream
attribution: NOTICE file.

### Premium Edition

LeavePilot Premium is a proprietary module requiring a license.
Premium Edition includes:
- OIDC/SAML SSO
- Employee groups
- Work calendars
- Integration API
- Time balance
- Vacation planning

For licensing and usage terms:
- [EULA](docs/EULA.md)
- [Privacy Policy](docs/PRIVACY.md)

## Feedback

If you find a bug in the code or documentation, create an issue in the repository or update the instructions for your deployment setup.
