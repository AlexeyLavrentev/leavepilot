'use strict';

/*
  An operator who deploys via `docker compose up` and sets BRAND_NAME (and the
  rest of the brand env vars) in .env or the host shell expects every branded
  surface - login eyebrow, page title, footer, web manifest, email From, iCal
  PRODID/X-WR-CALNAME - to reflect the new brand without a code edit. That is
  the operator-deployment promise of Phase 2 (BRAND-04), and it is the truth
  that G-02-1 broke.

  Root cause (G-02-1): docker-compose does NOT auto-forward host env into
  containers. Only vars listed under `services.app.environment:` with `${VAR}`
  interpolation are passed. BRAND_NAME and the rest of the brand env surface
  were absent from all four compose files, so process.env.BRAND_NAME was
  undefined inside the container, branding.get() fell through to the LeavePilot
  defaults baked into lib/branding.js (D-01), and nothing changed - the user
  reported "сборка все равно осталась по старому, ничего как будто бы не
  поменялось". The code path (lib/branding.js -> envResolver.getEnv) was always
  correct; only the deployment-configuration layer was broken.

  This guard asserts the deployment promise delivered in plan 02-07 is not
  silently undone by a future compose edit. It enumerates the AUTHORITATIVE
  brand env-var set - every name lib/branding.js get() reads via
  envResolver.getEnv(...) - and requires each to appear as a `${VAR:-}` entry
  in the app-service environment block of all four compose entrypoints.

  Kept as a test rather than done once. Adding a new brand env var to
  lib/branding.js without wiring it through compose would re-open G-02-1 for
  that single surface, and the author of the branding change has no reason to
  grep the compose files. The missing-list message names exactly which
  (file, var) pair was dropped so the regression is obvious.

  D-12 boundary: the "compose files untouched" policy from decision D-12 was
  superseded for the BRAND_* propagation concern ONLY (authorized by the
  owner's G-02-1 fix decision). D-12's other commitments stay intact - DB
  defaults (`DB_NAME`/`MYSQL_DATABASE` = `timeoff`) and the
  `.timeoff-commercial` marker are NOT brand surfaces and must not move. The
  last teeth spec pins the DB default so a future edit cannot satisfy the
  brand test while regressing the D-12 DB-default commitment.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');

// Mirrors the read() helper in t/unit/license_consistency.js so this watchdog
// reads the compose files the same way the licence watchdog reads its surfaces.
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

/*
  The AUTHORITATIVE brand env-var surface: every name lib/branding.js get()
  reads via envResolver.getEnv(...). Enumerate from that file - do not
  paraphrase, do not trim. The three unprefixed names
  (APPLICATION_SENDER_EMAIL, APPLICATION_DOMAIN, PROMOTION_WEBSITE_DOMAIN) are
  brand-related but carry no BRAND_ prefix (D-05: BRAND_ is neutral, not the
  only brand surface); branding.get() reads them, so they propagate too.
*/
const EXPECTED = [
  'BRAND_NAME',
  'BRAND_SHORT_NAME',
  'BRAND_LOGO_URL',
  'BRAND_FAVICON_URL',
  'BRAND_FAVICON_PNG_32_URL',
  'BRAND_FAVICON_PNG_16_URL',
  'BRAND_APP_ICON_URL',
  'BRAND_APPLE_TOUCH_ICON_URL',
  'BRAND_MANIFEST_URL',
  'BRAND_SENDER_EMAIL',
  'APPLICATION_SENDER_EMAIL',
  'BRAND_SENDER_NAME',
  'BRAND_EMAIL_FROM',
  'APPLICATION_DOMAIN',
  'PROMOTION_WEBSITE_DOMAIN',
];

/*
  The four documented compose entrypoints. docker-compose.yml and
  docker-compose.community-image.yml are standalone; docker-compose.dev.yml and
  docker-compose.commercial.yml are overlays layered over the base. All four
  define services.app.environment, and all four must forward BRAND_* so the
  operator-deployment promise holds regardless of which entrypoint is used.
*/
const COMPOSE_FILES = [
  'docker-compose.yml',
  'docker-compose.dev.yml',
  'docker-compose.community-image.yml',
  'docker-compose.commercial.yml',
];

/*
  True when `content` contains a line like `      BRAND_NAME: ${BRAND_NAME:-}`:
  start-of-line, optional indentation, the var name, a colon, optional
  whitespace, then the ${VAR:-} interpolation form with an EMPTY default.

  The empty default is load-bearing: it lets an unset var resolve to empty
  (not the literal string "BRAND_NAME") so branding.get() falls back to the
  LeavePilot defaults (D-01) for an unmodified deploy. A line like
  `BRAND_NAME: ${BRAND_NAME:-LeavePilot}` would freeze the brand at the default
  and must not match - the teeth spec below proves the predicate rejects it.
*/
const hasBrandVar = (content, name) => {
  const escaped = escapeRegexp(name);
  const re = new RegExp(
    '^[ \\t]*' + escaped + ':[ \\t]*\\$\\{' + escaped + ':-\\}[ \\t]*$',
    'm'
  );
  return re.test(content);
};

// Escape regex metacharacters in a var name so the predicate composes safely.
// (Mirrors the escapeRegexp helper in t/unit/package_branding.js.)
function escapeRegexp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('BRAND-04 deployment: compose forwards the brand env surface', function() {

  it('has the four compose surfaces to check', function() {
    // A green run must not be vacuous: if a compose file were deleted or
    // renamed, the contract loop below would pass trivially. Mirror the
    // surfaces-exist guard in license_consistency.js (L101-106).
    const missing = COMPOSE_FILES.filter(file => !fs.existsSync(path.join(root, file)));
    expect(
      missing,
      'these compose files are gone, so the guard has nothing to check: ' + missing.join(', ')
    ).to.deep.equal([]);
  });

  it('forwards every brand env var read by lib/branding.js in every compose app-service environment', function() {
    // The contract spec: for every (file, name) pair the `${VAR:-}` entry must
    // be present. On failure the missing-list names exactly which pair was
    // dropped, so the regression points at the line to restore.
    const missing = [];
    COMPOSE_FILES.forEach(function(file) {
      const content = read(file);
      EXPECTED.forEach(function(name) {
        if (!hasBrandVar(content, name)) {
          missing.push(file + ': ' + name);
        }
      });
    });
    expect(
      missing,
      'these (file, var) pairs are missing the ${VAR:-} propagation that closes G-02-1'
    ).to.deep.equal([]);
  });

  it('TEETH: catches a removed BRAND_NAME line (predicate is not vacuous)', function() {
    // Negative control: delete docker-compose.yml's BRAND_NAME line and assert
    // the predicate flips to false. Without this, hasBrandVar could return
    // true unconditionally and the contract spec above would pass vacuously.
    const content = read('docker-compose.yml');
    const mutated = content.replace(/^[ \t]*BRAND_NAME:[^\n]*\n/m, '');
    expect(
      mutated,
      'sanity check: the mutation must actually change docker-compose.yml (was BRAND_NAME already absent?)'
    ).to.not.equal(content);
    expect(hasBrandVar(mutated, 'BRAND_NAME')).to.equal(false);
  });

  it('TEETH: rejects a hardcoded brand value (the ${VAR:-} interpolation shape is enforced)', function() {
    // If someone replaced `${BRAND_NAME:-}` with a literal string, every
    // operator's deploy would freeze at that value and the rebrand path this
    // guard protects would silently break. The predicate must reject a frozen
    // literal, proving it enforces the interpolation shape, not just the key.
    const content = read('docker-compose.yml');
    const frozen = content.replace(/\$\{BRAND_NAME:-\}/, 'AcmeCorp');
    expect(
      frozen,
      'sanity check: the mutation must actually change docker-compose.yml'
    ).to.not.equal(content);
    expect(hasBrandVar(frozen, 'BRAND_NAME')).to.equal(false);
  });

  it('TEETH: DB defaults stay unchanged in docker-compose.yml (D-12 honored outside the BRAND_* concern)', function() {
    // D-12's "compose untouched" policy was superseded for BRAND_* propagation
    // ONLY. DB defaults are infra, not a brand surface, and renaming them
    // breaks existing deploys (data lives in the `timeoff` volume). Pin
    // DB_NAME to its ${DB_NAME:-timeoff} default so a future edit cannot
    // satisfy the brand test while regressing the D-12 DB-default commitment.
    const content = read('docker-compose.yml');
    expect(
      content,
      'DB_NAME must remain ${DB_NAME:-timeoff} (D-12: DB defaults are not a brand surface)'
    ).to.match(/^[ \t]*DB_NAME:[ \t]*\$\{DB_NAME:-timeoff\}[ \t]*$/m);
  });

});
