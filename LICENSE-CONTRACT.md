# LeavePilot License Contract

Contract-Version: 1.0

This document is the single normative contract for the license format exchanged
between the two LeavePilot repositories: the community repository (this repo,
which contains the verifier) and the portal repository (which contains the
issuer). It covers exactly three components: (1) the signed license envelope
and its payload, `schemaVersion` 2; (2) the signed revocation list,
`schemaVersion` 1; and (3) the environment contract through which a deployment
feeds both to the verifier. The companion `license-contract-fixtures/` package
at the repository root proves every documented outcome against the real
verifier in CI on every pull request. Where this document and any other
document disagree, this document wins.

## Changelog

| Version | Date       | Change                                                                     |
|---------|------------|----------------------------------------------------------------------------|
| 1.0     | 2026-08-17 | Initial contract: license schemaVersion 2, revocation-list schemaVersion 1, env contract. |

## Scope and Non-goals

This contract defines the **format and exchange semantics** of licenses only:
which fields exist, what they mean, how bytes are signed and verified, and
which environment variables carry the material. The behavioral truth of every
outcome named here is the community verifier (`lib/features.js`); the fixture
package pins that truth in CI.

Non-goals (deliberately out of scope):

- Portal internals: trial flow, UI, database schema, customer management.
- The signing-provider interface (how the portal stores its private key is the
  portal's own concern).
- Issuance and revocation operations and processes (they live in the portal's
  operator documentation, e.g. `license-operations`).
- Deployment (how env values reach a host — compose files, secrets mounts — is
  the deployment zone's concern; this contract only names the variables).

## 1. License Envelope and Payload (schemaVersion 2)

A license is an **envelope**: a JSON object with a `payload`, an `algorithm`,
and a `signature`. The signature is computed over the canonicalized JSON of
the payload alone; the envelope never contains a signature over itself.

```json
{
  "payload": { ... },
  "algorithm": "RSA-SHA256",
  "signature": "<base64>"
}
```

### Payload fields

Every field below is part of the contract. The Semantics column records what
the code does today — the contract is a description of behavior, not an
aspiration.

| Field                  | Type / requirement                | Written by      | Semantics (as the verifier behaves) |
|------------------------|-----------------------------------|-----------------|-------------------------------------|
| `schemaVersion`        | integer, `2` for this format      | Portal          | Absent is treated as 1 (legacy). Any value other than 2 at 2 or above yields `unsupported_schema_version`. Legacy v1 payloads (using `expires`) are still accepted. |
| `licenseId`            | string, non-empty, required (v2)  | Portal (`crypto.randomUUID()`) | UUID. The key that matches this license against a revocation list. |
| `customerId`           | string, optional, non-empty if set | Portal (`String(customer.id)`) | Customer identification for logs and audit. Not an entitlement input. |
| `customerName`         | string, required (v2)             | Portal          | Primary customer field surfaced in license status. |
| `customer`             | string, optional                  | Portal (legacy duplicate) | Legacy duplicate of `customerName`. Status prefers `customerName` and falls back to `customer`. The portal writes both. |
| `features`             | array of non-empty strings, required (v2) | Portal (plan preset or manual override) | The only source of entitlement. Valid names resolve against the community `FEATURE_CATALOG`: `ldap_authentication`, `sso_authentication`, `integration_api`, `employee_groups`, `work_calendars`, `leave_start_reminders`, `custom_branding`. Unknown names are silently ignored by `getLicensedFeatureSet` — they neither fail verification nor grant anything. |
| `issuedAt`             | ISO 8601 date string, required (v2) | Portal (`new Date().toISOString()`) | Audit information. The verifier parses it for validity but never compares it to the current time. |
| `allowedMajorVersions` | array of integers >= 1, optional, non-empty if set | Portal (`[3]` today) | Must contain the community edition's major version (from the community `package.json`) or verification yields `unsupported_major_version`. This is the coupling between a license and the core release it was issued for. |
| `plan`                 | string, optional                  | Portal          | Informative for the verifier; the portal plan-preset name (normalized to lower case when the portal resolves presets). Not an entitlement input — `features` is. |
| `expiresAt`            | ISO 8601 date string, optional    | Portal          | The v2 expiry name; the v1 name `expires` is accepted as an alias. A past value enters the grace window and then yields `expired` (see Grace). |
| `maxActiveUsers`       | safe integer >= 1, optional       | Portal (`metadata.seats`) | Seat limit: enforced by the community `lib/licensing/seat_limit.js` as a per-company count of active users while the license is valid — including during grace, when `valid` is still `true`. Exceeding it blocks user creation/reactivation (`LICENSE_SEAT_LIMIT_EXCEEDED`) but never evicts existing active users. |
| `keyId`                | string, optional, non-empty if set | Portal (env `LICENSE_SIGNING_KEY_ID`) | Key rotation: selects the verification key from the `LEAVEPILOT_LICENSE_PUBLIC_KEYS` ring (see Key Rotation). Present without a matching ring entry yields `unknown_key_id`. Absent falls back to the single `LEAVEPILOT_LICENSE_PUBLIC_KEY`. |
| `notBefore`            | ISO 8601 date string, optional    | — (the portal does not write it) | A future value yields `not_yet_valid`. |
| `maintenanceUntil`     | ISO 8601 date string, optional    | — (status surface only) | Carried on the license status surface; not verified against the current time. |
| envelope `algorithm`   | `'RSA-SHA256'` (legacy `'HMAC-SHA256'` accepted) | Signing provider | Anything other than RSA-SHA256 or the legacy HMAC-SHA256 yields `unsupported_signature_algorithm`. RSA-SHA256 is the only sanctioned format for inter-repository exchange. |
| envelope `signature`   | base64 (RSA) / hex (HMAC legacy)  | Signing provider | The signature over the canonicalized payload JSON (rule below). |

### Canonicalization (the signature byte rule)

The signature is computed over the payload run through **recursive key
sorting**: every JSON object's keys are sorted lexicographically
(`Object.keys().sort()`), arrays keep their order, scalars are untouched, and
the result is passed to `JSON.stringify`. The byte output of that
transformation is what is signed and what is verified. There is no whitespace
or line-ending rule beyond what `JSON.stringify` produces. This exact rule is
implemented byte-identically in the verifier (`lib/features.js`), the portal
issuer (`services/license_service.js` in the portal repository), and the
fixture generator (`license-contract-fixtures/generate.js`); a fourth
implementation must copy it, not reinvent it.

### Signature algorithm

`RSA-SHA256` — `crypto.sign('RSA-SHA256', Buffer.from(canonicalJson(payload)), privateKey)`
encoded as base64. The legacy `HMAC-SHA256` envelope (shared-secret, hex
signature) is still accepted by the verifier for existing deployments, but it
is NOT a sanctioned format for exchange between the two repositories: the
portal signs with an RSA private key and the community verifies with the
matching public key.

### Example envelope

Shape of a real issued envelope (signature truncated for readability; the
fields and their order are what the portal issuer produces):

```json
{
  "payload": {
    "schemaVersion": 2,
    "licenseId": "1c9167a1-0cbb-4159-bb9d-975ba873eddf",
    "customerId": "fb404337-2d61-4b6e-9a2e-08e1d64acbee",
    "customerName": "Phase-7 Parity Stand Customer",
    "customer": "Phase-7 Parity Stand Customer",
    "features": ["sso_authentication", "integration_api", "employee_groups", "work_calendars"],
    "issuedAt": "2026-08-16T18:08:30.939Z",
    "allowedMajorVersions": [3],
    "plan": "pro",
    "expiresAt": "2027-08-16T18:08:30.937Z"
  },
  "algorithm": "RSA-SHA256",
  "signature": "cMQjHMcV…"
}
```

### Compatibility

Backward compatibility: adding a payload field, a reason outcome, or an
environment variable is a non-breaking (contract-minor) change — old licenses
remain valid. Removing or renaming a field, changing the canonicalization byte
rule, changing the signature algorithm, or changing any semantics in a way
that would make a verifier on either side reject the other side's licenses is
a breaking (contract-major) change that requires both repositories to step to
the new major version **in the same change** (see Versioning and Change
Procedure).

## 2. Grace

Expiry is a commercial condition, not a tamper signal. When `expiresAt` is in
the past, the license enters a grace window of `LICENSE_GRACE_DAYS` days
(default **14**) counted from `expiresAt`:

- Inside the window the license stays **valid**: `valid: true`, reason
  `expired_in_grace`, `inGrace: true`, and `graceEndsAt` surfaced on the
  status. The signed payload is still read, so **premium features keep
  working** — with one exception: `custom_branding` is suppressed during
  grace per the `FEATURE_CATALOG` rule (the white-label entitlement is never
  granted by grace).
- After the window: `valid: false`, reason `expired`. Community functionality
  and data access are **never blocked** by expiry — only entitlements go
  dark.

`LEAVEPILOT_LICENSE_GRACE_DAYS` is operator tuning **inside** the contract:
accepted range 0..14, default 14. An operator may **lower** the window (down
to 0) but can never raise it — the verifier caps the configured value at 14
(`Math.min`), so a commercial entitlement cannot be extended via an
environment variable.

## 3. Key Rotation (`keyId`)

Keys rotate without breaking licenses in the field:

- A payload carrying `keyId` selects its verification key from the
  `LEAVEPILOT_LICENSE_PUBLIC_KEYS` environment variable — a JSON map of
  `keyId` -> PEM public key (the rotation ring). The portal stamps `keyId`
  from its `LICENSE_SIGNING_KEY_ID` when issuing.
- An **ordered ring**: a newly added key serves new licenses while previously
  issued licenses keep verifying against the old key until they expire —
  rotation with no break.
- A payload with `keyId` but no matching ring entry fails closed with reason
  `unknown_key_id`.
- A payload without `keyId` verifies against the single
  `LEAVEPILOT_LICENSE_PUBLIC_KEY`.

## 4. Revocation List (schemaVersion 1)

Revocation is a separate signed artifact fed through its own environment
variable, verified with its own key (a compromised license-signing key must
not be able to forge revocations, and vice versa).

```json
{
  "payload": {
    "schemaVersion": 1,
    "listId": "<uuid>",
    "issuedAt": "<ISO 8601>",
    "expiresAt": "<ISO 8601>",
    "revokedLicenseIds": ["<licenseId>", "..."]
  },
  "algorithm": "RSA-SHA256",
  "signature": "<base64>"
}
```

| Field                 | Semantics (as the verifier behaves) |
|-----------------------|-------------------------------------|
| `schemaVersion`       | Must be exactly 1. |
| `listId`              | UUID, informative. |
| `issuedAt`            | ISO 8601. A future value fails the list (`revocation_list_not_yet_valid`). |
| `expiresAt`           | ISO 8601. A past value fails the list (`revocation_list_expired`) — the list lives in a window and must be re-issued. |
| `revokedLicenseIds`   | Array of non-empty strings. Membership by `licenseId` yields `valid: false`, reason `revoked`, with `revokedAt` set to the list's `issuedAt`. |
| envelope              | Same canonicalization byte rule and RSA-SHA256 algorithm as licenses. There is **no keyId ring** for lists — a single key. |

Verification order and semantics:

- The list check applies **only to an already-valid license**; an invalid
  license reports its own failure reason.
- The list key comes from `LEAVEPILOT_LICENSE_REVOCATION_PUBLIC_KEY`, with
  fallback to the single license public key when unset.
- An invalid, stale, or unsigned list **invalidates the license** (fail
  closed: `invalid_revocation_list` / `invalid_revocation_list_payload` /
  `revocation_list_not_yet_valid` / `revocation_list_expired`) — a missing or
  broken list can never silently un-revoke.
- When the list is absent from the environment, the check is skipped
  entirely.
- When a valid list does NOT contain the license's `licenseId`, the status
  surfaces `revocationListIssuedAt` and `revocationListExpiresAt` — positive
  proof the list was consulted.

The legacy `HMAC-SHA256` envelope is accepted by the license verifier for
existing deployments (see Signature algorithm), but revocation lists, like
inter-repository license exchange, are `RSA-SHA256` only.

## 5. Environment Contract

The verifier reads license material from the environment (the same values may
also be provided through configuration; environment variables win). The
runtime reads **content only** — a value that is a file path is never opened
by the runtime; file paths belong to the CLI/deployment zone (`bin/license.js
inspect|verify <license-file-or-string>`, `--public-key-file`, portal secrets
mounts).

| Variable                                   | Semantics |
|--------------------------------------------|-----------|
| `LEAVEPILOT_LICENSE`                       | The license envelope as JSON text, or base64-encoded JSON (both are parsed). Never a file path. The generation-1 alias `TIMEOFF_LICENSE` is supported forever and warns once at boot; when both are set, `LEAVEPILOT_LICENSE` wins. |
| `LEAVEPILOT_LICENSE_PUBLIC_KEY`            | Single PEM public key, used for payloads without `keyId`. |
| `LEAVEPILOT_LICENSE_PUBLIC_KEYS`           | JSON map of `keyId` -> PEM public key: the ordered rotation ring (see Key Rotation). |
| `LEAVEPILOT_LICENSE_REVOCATION_LIST`       | The revocation-list envelope (JSON text or base64-encoded JSON). Absent skips the revocation check. |
| `LEAVEPILOT_LICENSE_REVOCATION_PUBLIC_KEY` | PEM public key of the revocation list. Unset falls back to the single license public key. |
| `LEAVEPILOT_LICENSE_GRACE_DAYS`            | Grace window in days: 0..14, default 14. Operators may lower it, never raise it (see Grace). |
| `ALLOW_UNSIGNED_LICENSES`                  | The unsigned-payload test door. **Unprefixed** — it is read directly from `process.env`, not through the generation resolver; no prefixed spelling of this name exists. Honored only where `NODE_ENV` is neither `production` nor `staging` and not in the commercial edition; an explicit value is respected in those non-production modes; the default is `true` only when `NODE_ENV === 'test'`. This door is what makes the verifier NOT verify in test environments — it is part of the contract precisely so the document does not stay silent about it. |

## 6. Test Keys

The `license-contract-fixtures/keys/*.testkey` files are **fixtures, not
secrets**. They exist so that both repositories can regenerate and verify the
fixture package without access to any real key material:

- Nobody trusts these keys. The `keyId` stamped in every fixture
  (`test-license-do-not-trust`) makes any accidental use visible in every
  license-status surface.
- Operators install **their own portal's** public key
  (`LEAVEPILOT_LICENSE_PUBLIC_KEY(S)`). Configuring a test key as a
  verification key grants nothing but test entitlements and is visible as
  such.
- The owner's genesis key pair (the real signing pair from the portal
  extraction) is **never** copied into this package in any form — not the
  private half, not the public half, not embedded in the generator.
- The private halves are committed deliberately (D-13): they are allowlisted
  in `.gitleaksignore` by fingerprint scoped to exactly those two files; any
  other private-key finding in either repository fails its secret scan.

## 7. Change Procedure

The community repository is the **single source of changes** to this contract
and its fixture package. Every change — document, fixtures, keys, generator —
follows the same four steps:

1. **Change the package in the community repository** (LICENSE-CONTRACT.md
   and/or `license-contract-fixtures/`, never the portal copy).
2. **Regenerate the manifest**: `node license-contract-fixtures/generate.js`
   rewrites the fixtures and `MANIFEST.json` deterministically (all dates are
   hard constants around the frozen now `2026-06-01T00:00:00.000Z`; the
   output never depends on the runtime clock).
3. **Copy byte-for-byte into the portal repository**: LICENSE-CONTRACT.md and
   the whole `license-contract-fixtures/` directory are identical in both
   repositories.
4. **Both sides green before merge**: the `license-contract` CI job must pass
   in both repositories. A one-sided change fails on the changed side
   (manifest mismatch) or on the other side (its own manifest no longer
   matches the mirrored files) — that is the point.

A **contract-major** step additionally requires a Changelog entry stating the
date support for the old version is removed.

Operational rule (community major bumps): when the community edition's major
version changes, the fixture package MUST be regenerated with an updated
`allowedMajorVersions` (e.g. moving to `[3, 4]` or `[4]`) as part of that
release — otherwise every "valid" fixture starts failing with
`unsupported_major_version`. Because previously issued licenses remain valid
when the new major is added alongside the old, this regeneration is a
contract-**minor** step, not a major one.

## 8. Versioning

Contract versions are `major.minor`, recorded in the header line and the
Changelog above.

- **Major (breaking)**: a change after which a verifier on either side would
  reject the other side's licenses — removing or renaming a field, changing
  the canonicalization byte rule, changing the signature algorithm, altering
  grace or revocation semantics incompatibly. Both repositories MUST step to
  the new major version in the same change; there is no window where the
  sides disagree. A major step records in the Changelog the date support for
  the old version is removed.
- **Minor (additive)**: adding a payload field, a reason outcome, or an env
  variable — old licenses and old lists stay valid. One repository may step
  first (recording the addition in its copy of this document and manifest);
  the other records it in its next mirror step. The `MANIFEST.json`
  `contractVersion` always equals the document header version (asserted in
  CI on both sides).
