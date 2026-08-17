#!/usr/bin/env node
'use strict';

/*
  License contract fixture generator (Phase 8, D-15/D-16/D-18).

  Regenerates the committed fixture package deterministically: the same input
  constants always produce byte-identical output (RSA-SHA256 with PKCS#1 v1.5
  is deterministic; every date and id below is a hard constant).

  Regeneration procedure (D-20; the same steps live in LICENSE-CONTRACT.md
  "Change Procedure"):
    1. change the package in the COMMUNITY repository (never the portal copy);
    2. run this script — it rewrites every fixture and MANIFEST.json;
    3. copy the package byte-for-byte into the portal repository;
    4. both sides' CI must be green before either merge is done.

  This script is byte-identical in both repositories and requires NOTHING
  beyond node builtins (fs, path, crypto): repo module paths differ between
  the two repositories and must never be required here. The community major
  version stamped into allowedMajorVersions is a hard constant for the same
  reason — never read from package.json.

  All fixture dates are hard constants anchored to FROZEN (D-16): the spec
  freezes the verifier clock to FROZEN, so the committed fixtures never rot.
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PKG_DIR = __dirname;
const REPO_ROOT = path.join(PKG_DIR, '..');

// The single frozen "now" of the whole package (D-16). The spec runs the real
// verifier with Date frozen here; every window in the fixtures is computed
// around this constant by hand, never from the runtime clock.
const FROZEN_ISO = '2026-06-01T00:00:00.000Z';
const FROZEN = Date.parse(FROZEN_ISO);

// The community major the fixtures claim (see header comment; hard constant).
const COMMUNITY_MAJOR = 3;

// D-13: the keyId marks every fixture as test-only. Nobody trusts these keys.
const KEY_ID = 'test-license-do-not-trust';

const LICENSE_PRIVATE_KEY_FILE = path.join(PKG_DIR, 'keys', 'test-license.private.testkey');
const REVOCATION_PRIVATE_KEY_FILE = path.join(PKG_DIR, 'keys', 'test-revocation.private.testkey');

/*
  Canonicalization + signing — the byte rule of the contract, inlined as the
  third byte-equivalent copy (lib/features.js, portal license_service.js, and
  this script). Do not "improve" it: any divergence breaks every signature.
*/
const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonicalize(value[key]);
      return acc;
    }, {});
  }
  return value;
};

const canonicalJson = value => JSON.stringify(canonicalize(value));

const signPayload = (payload, privatePem) =>
  crypto.sign('RSA-SHA256', Buffer.from(canonicalJson(payload)), privatePem).toString('base64');

// ---------------------------------------------------------------------------
// Fixed inputs (D-15/D-16: hard constants only — no runtime clock, no random).
// ---------------------------------------------------------------------------

const CUSTOMER_NAME = 'LeavePilot Contract Fixture Customer';
const FEATURES = [
  'ldap_authentication',
  'sso_authentication',
  'integration_api',
  'employee_groups',
  'work_calendars',
  'custom_branding',
];

const LICENSE_ID_VALID = '00000000-0000-4000-8000-000000000001';
const LICENSE_ID_REVOKED = '00000000-0000-4000-8000-000000000002';
const LICENSE_ID_MISS = '00000000-0000-4000-8000-000000000003';
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000a1';

const EXPIRES_FAR_FUTURE = '2099-06-01T00:00:00.000Z';
const EXPIRES_LONG_PAST = '2020-01-01T00:00:00.000Z';
const EXPIRES_GRACE = '2026-05-25T00:00:00.000Z'; // FROZEN minus 7 days (inside the 14-day window)

const REVOCATION_LIST_ID = '00000000-0000-4000-8000-0000000000b1';

// Payload construction in the portal issuer's field order
// (services/license_service.js): fixed core first, optional commercial
// fields after.
const buildPayload = overrides => Object.assign({
  schemaVersion: 2,
  licenseId: LICENSE_ID_VALID,
  customerId: CUSTOMER_ID,
  customerName: CUSTOMER_NAME,
  customer: CUSTOMER_NAME,
  features: FEATURES.slice(),
  issuedAt: FROZEN_ISO,
  allowedMajorVersions: [COMMUNITY_MAJOR],
  plan: 'pro',
  expiresAt: EXPIRES_FAR_FUTURE,
  maxActiveUsers: 25,
  keyId: KEY_ID,
}, overrides || {});

const buildEnvelope = (payload, privatePem) => ({
  payload,
  algorithm: 'RSA-SHA256',
  signature: signPayload(payload, privatePem),
});

const writeJson = (relPath, value) => {
  fs.writeFileSync(path.join(PKG_DIR, relPath), JSON.stringify(value, null, 2) + '\n');
};

// ---------------------------------------------------------------------------
// Fixture definitions. Each entry states why it exists (the meta block is the
// oem-leak manifest discipline: no entry without an honest reason).
// ---------------------------------------------------------------------------

const fixtures = {

  'valid.json': {
    envelope: licenseKey => buildEnvelope(buildPayload(), licenseKey),
    meta: {
      outcome: 'valid',
      expectedReason: 'valid',
      env: [],
      why: 'Baseline positive: a correctly signed schemaVersion-2 payload with keyId resolves through the key ring and verifies valid at the frozen now (2026-06-01, before the 2099 expiry).',
    },
  },

  'invalid-signature.json': {
    // The valid payload signed with the WRONG key (the revocation pair) —
    // deterministic, and exactly the "signature does not match the trusted
    // public key" class.
    envelope: (licenseKey, revocationKey) => buildEnvelope(buildPayload(), revocationKey),
    meta: {
      outcome: 'invalid-signature',
      expectedReason: 'invalid_signature',
      env: [],
      why: 'Tamper class: the payload is well-formed and signed, but by a key the verifier does not trust for licenses — verification must fail closed on the signature itself.',
    },
  },

  'expired.json': {
    envelope: licenseKey => buildEnvelope(
      buildPayload({expiresAt: EXPIRES_LONG_PAST}), licenseKey),
    meta: {
      outcome: 'expired',
      expectedReason: 'expired',
      env: [],
      why: 'Expiry beyond any grace window: 2020-01-01 plus the default 14 days is far before the frozen now, so the license must be rejected as expired (community functionality is never blocked, only entitlements).',
    },
  },

  'grace.json': {
    envelope: licenseKey => buildEnvelope(
      buildPayload({expiresAt: EXPIRES_GRACE}), licenseKey),
    meta: {
      outcome: 'grace',
      expectedReason: 'expired_in_grace',
      env: [],
      why: 'Grace window interior: expiry 2026-05-25 is 7 days before the frozen now, inside the default 14-day window — the license stays valid (premium features live, custom_branding suppressed) with reason expired_in_grace.',
    },
  },

  'revoked.json': {
    envelope: licenseKey => buildEnvelope(
      buildPayload({licenseId: LICENSE_ID_REVOKED}), licenseKey),
    meta: {
      outcome: 'revoked',
      expectedReason: 'revoked',
      env: [
        'LEAVEPILOT_LICENSE_REVOCATION_LIST',
        'LEAVEPILOT_LICENSE_REVOCATION_PUBLIC_KEY',
      ],
      why: 'Revocation hit: this licenseId is a member of the signed test revocation list, so an otherwise valid license must fail with reason revoked and revokedAt set to the list issuedAt.',
    },
  },

  'schema-mismatch.json': {
    envelope: licenseKey => buildEnvelope(
      buildPayload({schemaVersion: 3}), licenseKey),
    meta: {
      outcome: 'schema-mismatch',
      expectedReason: 'unsupported_schema_version',
      env: [],
      why: 'Defensive: a payload claiming schemaVersion 3 (correctly signed) is a format this verifier does not know — it must be rejected, never best-effort parsed.',
    },
  },

  'major-mismatch.json': {
    envelope: licenseKey => buildEnvelope(
      buildPayload({allowedMajorVersions: [2]}), licenseKey),
    meta: {
      outcome: 'major-mismatch',
      expectedReason: 'unsupported_major_version',
      env: [],
      why: 'Defensive: the payload allows only community major 2 while the verifying core is major 3 — the version coupling must reject the license instead of running unsupported combinations.',
    },
  },

  'revocation-miss.json': {
    envelope: licenseKey => buildEnvelope(
      buildPayload({licenseId: LICENSE_ID_MISS}), licenseKey),
    meta: {
      outcome: 'revocation-miss',
      expectedReason: 'valid',
      env: [
        'LEAVEPILOT_LICENSE_REVOCATION_LIST',
        'LEAVEPILOT_LICENSE_REVOCATION_PUBLIC_KEY',
      ],
      why: 'Positive control for the list path: this licenseId is NOT in the signed list, so the license stays valid AND the status surfaces revocationListIssuedAt/ExpiresAt — proving the list was actually consulted, not skipped.',
    },
  },
};

// The signed revocation list itself (schemaVersion 1, D-17). Wide window
// (2020 -> 2099) so the list can never expire relative to FROZEN (Pitfall 3).
const revocationListPayload = {
  schemaVersion: 1,
  listId: REVOCATION_LIST_ID,
  issuedAt: EXPIRES_LONG_PAST, // 2020-01-01: long before FROZEN
  expiresAt: EXPIRES_FAR_FUTURE, // 2099-06-01: long after FROZEN
  revokedLicenseIds: [LICENSE_ID_REVOKED],
};

fixtures['revocation-list.json'] = {
  envelope: (licenseKey, revocationKey) => ({
    payload: revocationListPayload,
    algorithm: 'RSA-SHA256',
    signature: signPayload(revocationListPayload, revocationKey),
  }),
  meta: {
    outcome: 'revocation-list',
    expectedReason: null,
    env: [],
    why: 'The signed test revocation list (schemaVersion 1, signed by the separate revocation test pair): revokes revoked.json licenseId only; consumed via env by the revoked and revocation-miss outcomes.',
  },
};

// Deliberately a fixed list, not a directory walk: regeneration must fail
// loudly when a required fixture disappears, and a dynamic list would simply
// shrink with it (scripts/verify-artifact-licenses.sh discipline).
const OUTPUT_FILES = [
  'valid.json',
  'invalid-signature.json',
  'expired.json',
  'grace.json',
  'revoked.json',
  'schema-mismatch.json',
  'major-mismatch.json',
  'revocation-miss.json',
  'revocation-list.json',
];

// The contract version this package pins (must equal the Contract-Version
// line in the LICENSE-CONTRACT.md header — the spec asserts the equality).
const CONTRACT_VERSION = '1.0';

// Everything the MANIFEST pins, as repo-root-relative POSIX paths (the
// package sits at the repository root in BOTH repositories, so the paths are
// identical on both sides). MANIFEST.json is deliberately absent — a file
// cannot contain its own hash (Pitfall 9); the spec's bidirectional set
// equality tooth enforces the exclusion. Fixed list, same fail-closed
// discipline as OUTPUT_FILES.
const PINNED_FILES = [
  '../LICENSE-CONTRACT.md',
  'generate.js',
  'keys/test-license.private.testkey',
  'keys/test-license.public.testkey',
  'keys/test-revocation.private.testkey',
  'keys/test-revocation.public.testkey',
].concat(OUTPUT_FILES);

// Repo-root-relative POSIX form for the MANIFEST keys.
const manifestKey = packageRelative =>
  packageRelative === '../LICENSE-CONTRACT.md'
    ? 'LICENSE-CONTRACT.md'
    : 'license-contract-fixtures/' + packageRelative;

const sha256Hex = buffer =>
  crypto.createHash('sha256').update(buffer).digest('hex');

const MANIFEST_COMMENT = 'License contract package manifest (Phase 8, D-19). SHA256-pins LICENSE-CONTRACT.md and every file of license-contract-fixtures/ except this MANIFEST itself (self-hashing is impossible). Regeneration procedure (D-20): (1) change the package in the COMMUNITY repository only; (2) run node license-contract-fixtures/generate.js — it rewrites the fixtures and this manifest; (3) copy LICENSE-CONTRACT.md and license-contract-fixtures/ byte-for-byte into the portal repository; (4) both repositories CI green before either merge. All fixture dates are hard constants around the frozen now 2026-06-01T00:00:00.000Z (D-16) — regeneration never moves them. Consumed by t/unit/license_contract_fixtures.js (community mocha spec) and scripts/license_contract_check.js (portal check script); CI-gated via the license-contract job in core-ci.yml (community) and ci.yml (portal). The test keys are fixtures marked test-only (keyId test-license-do-not-trust) — nobody trusts them; the owner genesis pair is never copied into this package in any form (D-13).';

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

const licensePrivateKey = fs.readFileSync(LICENSE_PRIVATE_KEY_FILE, 'utf8');
const revocationPrivateKey = fs.readFileSync(REVOCATION_PRIVATE_KEY_FILE, 'utf8');

OUTPUT_FILES.forEach(relPath => {
  const definition = fixtures[relPath];
  if (!definition) {
    throw new Error('OUTPUT_FILES names ' + relPath + ' but no fixture definition exists for it');
  }
  writeJson(relPath, {
    envelope: definition.envelope(licensePrivateKey, revocationPrivateKey),
    meta: definition.meta,
  });
});

// ---------------------------------------------------------------------------
// MANIFEST (D-19): pin the document + the whole package, self-excluded.
// Each value is an object {"sha256": "<hex>"} rather than a bare hex string:
// gitleaks' generic-api-key rule false-positives on the bare form, because
// the pinned paths for the key files (".../keys/*.testkey") read as a
// "key: <high-entropy-token>" pair next to the digest. Nesting the digest
// removes the false positive at the root — nothing is allowlisted.
// ---------------------------------------------------------------------------

const files = {};
PINNED_FILES
  .map(manifestKey)
  .sort()
  .forEach(key => {
    files[key] = {sha256: sha256Hex(fs.readFileSync(path.join(REPO_ROOT, key)))};
  });

writeJson('MANIFEST.json', {
  _comment: MANIFEST_COMMENT,
  contractVersion: CONTRACT_VERSION,
  files,
});

process.stdout.write(
  'license-contract-fixtures: wrote ' + OUTPUT_FILES.join(', ')
  + ' + MANIFEST.json (' + Object.keys(files).length + ' pinned files, frozen now: ' + FROZEN_ISO + ')\n');
