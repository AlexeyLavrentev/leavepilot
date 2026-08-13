'use strict';

/*
  The product name is a brand-layer value (lib/branding.js get().name), not a
  string that lives in any client locale catalog. A leaked "LeavePilot" /
  "Leave Pilot" / "TimeOff" literal in a translation.json means a rebrand
  stops at the locales a translator happened to edit — the visible product
  name drifts away from branding.get() the moment a new language is added or
  a translator restates the name in their own words. BRAND-05 closes that
  surface: the locales carry no product literal at all, and the brand render
  keys templates actually use (brand.name, brand.nameLower) are intercepted
  at render time by lib/view/helpers.js t() so they return branding.get().name.
  The login screen eyebrow and the page <title> render the brand via the
  {{brand_name}} helper instead, not via t().

  Kept as a test rather than done once. The next translator who opens a
  translation.json to localise the login screen will put the product name
  back in by reflex — nothing else in the file tells them it does not belong
  there — and the rebrand layer would then ship a half-renamed product. The
  watchdog scans every locale file for the three spellings of the name and
  fails the build on the first one that reappears.

  The three teeth assertions at the bottom exist because "no literal in the
  locales" is also true when the dynamic interception in helpers.js has been
  deleted AND the literal along with it: the visible product name would then
  render from whatever fallback the locale carries, which after this plan is
  the empty string. The teeth prove the interception still returns
  branding.get().name for brand.name and brand.nameLower (the keys footer.hbs
  and the email templates actually render), so the guard cannot be satisfied
  by removing the dynamic source the empty-string literals rely on.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const localesDir = path.join(root, 'public', 'locales');

const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

/*
  Every client locale catalog. The phase ships five languages
  (en, ru, uk, be, kk); a guard that scanned an empty list would be green on
  a deleted locales directory, so the count is asserted below (mirrors the
  surfaces-exist guard in license_consistency.js).
*/
const expectedLocales = ['en', 'ru', 'uk', 'be', 'kk'];

const surfaces = fs.readdirSync(localesDir)
  .filter(dir => fs.existsSync(path.join(localesDir, dir, 'translation.json')))
  .map(dir => 'public/locales/' + dir + '/translation.json');

/*
  The three spellings of the product name, case-insensitive: the camelCase
  token "TimeOff", and "LeavePilot" with and without the internal space.
  The generic phrase "Time off" / "time-off" (lowercase, separated) is NOT
  matched: the regex demands "TimeOff" as one camelCase token, so a sentence
  like "Staff Time off management system" in meta.description is a legitimate
  generic term, not a brand literal. The boundary is pinned by a teeth
  assertion below so the regex cannot quietly widen to catch the generic
  phrase, or narrow to drop a spelling.
*/
const brandLiteral = /LeavePilot|Leave\s+Pilot|TimeOff/i;

const offendersFor = pattern => surfaces.reduce((found, surface) => {
  read(surface).split('\n').forEach((line, index) => {
    if (pattern.test(line)) {
      found.push(surface + ':' + (index + 1) + ': ' + line.trim());
    }
  });

  return found;
}, []);

describe('Client locale catalogs carry no product-name literal', function() {

  it('has all five locale surfaces to check', function() {
    // The phase ships five client languages. A guard with an empty list —
    // e.g. after the locales directory is moved or renamed — would be green
    // on a deleted input, so the surface count is asserted first.
    expect(
      surfaces.length,
      'expected five locale surfaces (en, ru, uk, be, kk) — the guard lost its input'
    ).to.equal(expectedLocales.length);

    expectedLocales.forEach(lang => {
      expect(
        surfaces,
        'the ' + lang + ' locale surface is missing from public/locales/'
      ).to.include('public/locales/' + lang + '/translation.json');
    });
  });

  it('has no product-name literal in any locale', function() {
    const offenders = offendersFor(brandLiteral);
    expect(
      offenders,
      'these lines carry a product-name literal (LeavePilot / Leave Pilot / TimeOff) — ' +
      'the name must come from branding.get(), not a locale catalog:\n' +
      offenders.join('\n')
    ).to.deep.equal([]);
  });

  it('matches the three brand spellings and skips the generic phrase', function() {
    // Positive teeth: every spelling the guard exists to catch is matched.
    // If a future edit narrows the regex (e.g. drops the "Leave Pilot" space
    // alternation), one of these flips to false and the hole is loud.
    expect(brandLiteral.test('LeavePilot'), 'camelCase LeavePilot must be caught').to.equal(true);
    expect(brandLiteral.test('Leave Pilot'), 'spaced Leave Pilot must be caught').to.equal(true);
    expect(brandLiteral.test('TimeOff'), 'camelCase TimeOff must be caught').to.equal(true);
    expect(brandLiteral.test('leavepilot'), 'the match is case-insensitive').to.equal(true);
    expect(brandLiteral.test('log in to leavepilot with the new settings'), 'substring match inside a sentence').to.equal(true);

    // Negative teeth: the generic phrase that shares letters with the
    // TimeOff token is NOT caught, because the regex demands the camelCase
    // form. The locale copy (e.g. en meta.description "Staff Time off
    // management system") depends on this boundary.
    expect(brandLiteral.test('Time off management'), 'the generic "Time off" phrase must NOT be caught').to.equal(false);
    expect(brandLiteral.test('staff time-off management system'), 'the generic "time-off" phrase must NOT be caught').to.equal(false);
  });

  it('every locale file parses as valid JSON', function() {
    // A watchdog over invalid JSON is a silent hole: the literal scan splits
    // on lines and would happily report "no offender" on a half-written
    // file. Structural integrity is asserted separately so a broken catalog
    // fails here rather than passing the brand scan by accident.
    surfaces.forEach(surface => {
      let parsed;
      expect(
        () => { parsed = JSON.parse(read(surface)); },
        surface + ' is not valid JSON — a broken catalog would silence the brand-literal scan'
      ).to.not.throw();
      expect(parsed, surface + ' parsed to a non-object root').to.be.an('object');
    });
  });

  /*
    The brand-literal scan above is also satisfied by deleting the dynamic
    interception in lib/view/helpers.js and the literal along with it: the
    visible product name would then render from the empty-string fallback
    the locales now carry for brand.name / brand.nameLower. The teeth below
    prove the interception still returns branding.get().name for the two
    keys templates actually render (brand.name in the email templates,
    brand.nameLower in footer.hbs), so removing the dynamic source is a
    visible failure, not a silent pass.

    helpers.js is required here, not at module top level, so a structurally
    broken locale (caught by the valid-JSON spec above) fails this describe
    instead of crashing the whole file at load time — initI18next() reads
    the catalogs when helpers is first required.
  */
  describe('the dynamic brand interception the empty literals rely on', function() {

    let helpers;

    before(function() {
      helpers = require('../../lib/view/helpers')();
    });

    let savedBrandName;

    beforeEach(function() {
      // branding.get() reads BRAND_NAME live on every call (env_resolver has
      // no cache), so a unique sentinel value set here proves the helper
      // routes the key through branding.get() rather than a locale literal.
      savedBrandName = process.env.BRAND_NAME;
      process.env.BRAND_NAME = 'Teeth Brand';
    });

    afterEach(function() {
      if (typeof savedBrandName === 'undefined') {
        delete process.env.BRAND_NAME;
      } else {
        process.env.BRAND_NAME = savedBrandName;
      }
    });

    it('returns the dynamic brand name for the brand.name key', function() {
      expect(
        helpers.t('brand.name', {hash: {}}),
        't("brand.name") no longer returns branding.get().name — the empty locale fallbacks rely on this interception'
      ).to.equal('Teeth Brand');
    });

    it('returns the dynamic brand name LOWERCASED for the brand.nameLower key', function() {
      expect(
        helpers.t('brand.nameLower', {hash: {}}),
        't("brand.nameLower") no longer returns branding.get().name lowercased — footer.hbs renders this key (D-09)'
      ).to.equal('teeth brand');
    });
  });
});

/*
  The licenseStatus.* namespace (added in plan 03-01) is the single suppressible
  license surface after the D-01 banner removal (plan 03-02). A brand or URL
  literal in one of its values — "Visit LeavePilot", "https://timeoff.management"
  — is an OEM leak surface (Phase 4): the brand name and the upsell URL must
  flow from branding.get() through the mapper (lib/license_status_view.js),
  never from a locale catalog. The watchdog below forbids that.

  This scan is deliberately SCOPED to the parsed licenseStatus object's own
  string values. The global brandLiteral regex above already guards the whole
  file against the product NAME (LeavePilot / Leave Pilot / TimeOff) and is
  left byte-unchanged — widening it to https?:// would false-positive on the
  oidcSectionHelp values (e.g. en L1224) that legitimately carry a Keycloak
  issuer URL "https://<host>/realms/<realm>" as part of their guidance. Parsing
  the catalog and walking ONLY the licenseStatus object keeps oidcSectionHelp
  out of scope by construction, so the URL guard does not regress the build.
*/
const licenseStatusLiteral = /LeavePilot|Leave\s+Pilot|TimeOff|timeoff\.management|https?:\/\//i;

describe('licenseStatus.* locale values carry no brand or URL literal', function() {

  // Flatten only the licenseStatus object's own string leaves. The mapper
  // renders plain strings (lib/view/helpers.js t()), so a JSON parse + a
  // recursive walk over this one object is the correct shape — and it keeps
  // the oidcSectionHelp keys (which legitimately contain https://) out of the
  // URL scan by construction, which a whole-file line scan could not.
  const flattenStringLeaves = function(value, found) {
    if (typeof value === 'string') {
      found.push(value);
    } else if (value && typeof value === 'object') {
      Object.keys(value).forEach(function(key) { flattenStringLeaves(value[key], found); });
    }
    return found;
  };

  it('has the licenseStatus namespace in every client catalog', function() {
    // Surface-exists: a guard that scanned an absent namespace would be green
    // on a deleted input (mirrors the five-surfaces guard above). The scan
    // cannot pass by deleting the licenseStatus object the mapper renders.
    expectedLocales.forEach(function(lang) {
      const parsed = JSON.parse(read('public/locales/' + lang + '/translation.json'));
      expect(
        parsed.licenseStatus,
        'public/locales/' + lang + '/translation.json has no licenseStatus object — the scoped URL/brand-literal guard lost its input'
      ).to.be.an('object').that.is.not.empty;
    });
  });

  it('has no brand or URL literal in any licenseStatus value', function() {
    const offenders = [];
    surfaces.forEach(function(surface) {
      const parsed = JSON.parse(read(surface));
      const values = flattenStringLeaves(parsed.licenseStatus, []);
      values.forEach(function(value) {
        if (licenseStatusLiteral.test(value)) {
          offenders.push(surface + ': ' + value);
        }
      });
    });
    expect(
      offenders,
      'these licenseStatus.* values carry a brand or URL literal (LeavePilot / Leave Pilot / TimeOff / timeoff.management / http(s)://) — ' +
      'the name and upsell URL must come from branding.get(), not a locale catalog:\n' +
      offenders.join('\n')
    ).to.deep.equal([]);
  });

  it('matches the brand spellings, the domain, and a URL, but skips placeholders', function() {
    // Positive teeth: every spelling the scoped guard exists to catch is
    // matched. If a future edit narrows the regex (e.g. drops the https?://
    // alternation), one of these flips to false and the hole is loud. These
    // also prove the main spec above is non-vacuous: a real offender seeded
    // into a licenseStatus value would be caught and fail the build.
    expect(licenseStatusLiteral.test('Visit LeavePilot'), 'camelCase LeavePilot must be caught').to.equal(true);
    expect(licenseStatusLiteral.test('Visit Leave Pilot'), 'spaced Leave Pilot must be caught').to.equal(true);
    expect(licenseStatusLiteral.test('Powered by TimeOff'), 'camelCase TimeOff must be caught').to.equal(true);
    expect(licenseStatusLiteral.test('see timeoff.management'), 'the community default domain must be caught').to.equal(true);
    expect(licenseStatusLiteral.test('https://timeoff.management'), 'an https URL must be caught').to.equal(true);
    expect(licenseStatusLiteral.test('http://example.com/buy'), 'an http URL must be caught').to.equal(true);

    // Negative teeth: the clean placeholder-bearing copy the mapper actually
    // renders must NOT be flagged, so the guard cannot widen to catch the
    // {{plan}} / {{days}} / {{expires}} placeholders or normal punctuation.
    expect(licenseStatusLiteral.test('Premium активен ({{plan}}).'), 'a clean placeholder value must NOT be caught').to.equal(false);
    expect(licenseStatusLiteral.test('Premium active — expires in {{days}} day(s) ({{expires}}).'), 'a clean expiring value must NOT be caught').to.equal(false);
  });
});
