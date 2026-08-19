# Codebase Integrations

_Last mapped: 2026-08-19_

## External APIs

### License Portal
- **No runtime integration** — license is offline-only
- License JSON set via env `LEAVEPILOT_LICENSE`
- Public key via `LEAVEPILOT_LICENSE_PUBLIC_KEY` or `LEAVEPILOT_LICENSE_PUBLIC_KEYS` (key ring)
- Revocation list via `LEAVEPILOT_LICENSE_REVOCATION_LIST` (optional, signed artifact)
- No heartbeat, no phone-home, no online activation

### SSO / LDAP
- `lib/sso/` — OIDC/SAML provider integration
- `ldapauth-fork` — LDAP authentication
- Premium feature: `sso_authentication`

### Integration API
- `lib/route/api/` — REST API for external integrations
- Bearer token auth via Passport HTTP Bearer
- Premium feature: `integration_api`

### Telegram
- Premium module: `timeoff-premium/lib/` — telegram notifications
- `timeoff-premium/email_transport.js` — email transport

### External Connectors
- Premium module: `timeoff-premium/lib/` — external system connectors
- Premium feature: `external_connectors`

## Database

- **Primary**: SQLite (`sqlite3` package)
- **Alternative**: MySQL (`mysql2` package)
- **ORM**: Sequelize 6
- **Models**: `lib/model/db.js` — central model export
- **Migrations**: `migrations/` directory, run via umzug
- **Session store**: `connect-session-sequelize` (DB-backed sessions)
- **Optional**: Redis for session store (`connect-redis`)

## Authentication Providers

| Provider | Location | Notes |
|---|---|---|
| Local (email/password) | `lib/passport/` | Default, scrypt hashing |
| LDAP | `lib/passport/` + `ldapauth-fork` | Enterprise feature |
| SSO (OIDC/SAML) | `lib/sso/` | Premium feature |
| API Bearer | `lib/passport/` | For integration API |

## Email / Notifications

- **Nodemailer** — SMTP email transport
- **Templates**: `views/email/` (Handlebars)
- **Premium**: `timeoff-premium/email/` — additional email templates
- **i18n**: `locales/` — multi-language support (en, ru, be, kk, uk)

## License Portal Integration Points

Currently **none** at runtime. The integration boundary is:
1. Portal issues signed license JSON
2. Operator copies JSON to env var
3. App reads and verifies on startup and on each `getLicenseStatus()` call

**No**: activation endpoint, heartbeat, telemetry, remote revocation push.
