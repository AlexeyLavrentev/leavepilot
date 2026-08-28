'use strict';

/*
  OEM-03 / OEM-04 leak regression guard (D-08).

  The brand surfaces are DYNAMIC: every one reads branding.get() (or
  branding.getEmailFrom()), so under a custom_branding entitlement the vendor
  name is replaced by the operator's brand at render time. A static .hbs grep
  finds nothing — the templates carry {{brand_name}} / {{branding.faviconUrl}},
  not "LeavePilot". This test is the regression guard the grep cannot be: it
  RENDERS every manifest surface under a sentinel custom brand + oemActive:true
  and asserts BOTH that the sentinel brand IS present (custom-PRESENT — the
  surface genuinely reflects the operator brand) AND that NO vendor literal
  survives (vendor-ABSENT — LeavePilot / Leave Pilot / TimeOff /
  timeoff.management).

  The surface list is NOT hardcoded here. It lives in the grep-generated,
  repo-committed manifest t/fixtures/oem-leak-surfaces.json (D-08:
  grep-before-test, committed in repo, CI-gated every PR). This test ITERATES
  manifest.dynamic — a forEach over the manifest, NOT a representative subset
  — so adding a surface to the manifest is all it takes to extend coverage, and
  deleting the manifest makes the suite red (surfaces-exist guard).

  Pitfall-5 (the manifest cannot silently go stale): a COMPANION GREP below
  scans lib/ + app.js for every branding.get() / getEmailFrom() / brand.get(
  consumer and FAILS the build when a consumer is not accounted for in the
  manifest (dynamic[] or excluded[]). Its teeth prove a manifest surface
  genuinely consumes branding, so the allowlist is never a phantom. Modeled on
  t/unit/env_read_invariant.js (offender + allowlist + surfaces-exist shape),
  t/unit/locales_no_brand_literal.js (positive/negative teeth), and
  t/unit/license_status_view.js (sentinel-brand injection).

  CI-gated automatically: npm run test:coverage runs nyc mocha --recursive
  t/unit on every PR via .github/workflows/core-ci.yml.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const httpAgent = require('../lib/http_agent');
const branding = require('../../lib/branding');

const root = path.join(__dirname, '..', '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

// The manifest (D-08). Parsed directly; iterating it is the whole-list proof.
const manifest = JSON.parse(read('t/fixtures/oem-leak-surfaces.json'));

// The vendor literal regex. locales_no_brand_literal.js L64 extended with the
// community default domain (research §A). Case-insensitive: the alternations
// are letter-adjacency matches ("TimeOff" = T,i,m,e,O,f,f adjacent), so the /i
// flag catches any casing. The generic "Time off" / "time-off" phrases
// (space/hyphen separated) are NOT matched — pinned by the negative teeth below.
const brandLiteral = /LeavePilot|Leave\s+Pilot|TimeOff|timeoff\.management/i;

// D-11 one-way scope decision: the JS runtime namespace (window.timeoff /
// id="timeoff-config" / timeoff-theme) is OUT of leak scope — a devtools code
// identifier, not rendered brand text. The only brandLiteral-matching namespace
// token that survives into a full-page render is the static id="timeoff-config"
// in views/layouts/main.hbs (present on every page, including /login/). Masking
// it before the vendor-ABSENT assertion keeps the guard from false-positiving on
// the explicitly out-of-scope namespace. The mask is NARROW (one identifier), so
// it cannot hide a real brand-text leak.
const maskJsNamespace = html => String(html).replace(/timeoff-config/g, 'ns-config');

const SENTINEL_BRAND_NAME = 'Sentinel OEM';

// Sentinel branding injected into every render. Mirrors the shape
// branding.get() returns under a custom_branding entitlement (D-04 / D-06: the
// operator may override any of the 14 fields, so every brand-bearing field is
// set to a sentinel value). oemActive:true drives the D-07 suppression.
const SENTINEL_BRANDING = {
  name: SENTINEL_BRAND_NAME,
  shortName: 'Sentinel',
  applicationDomain: 'https://sentinel.example',
  promotionWebsiteDomain: 'https://sentinel.example',
  logoUrl: 'https://sentinel.example/logo.png',
  faviconUrl: '/favicon.ico',
  faviconPng32Url: '/favicon-32x32.png',
  faviconPng16Url: '/favicon-16x16.png',
  appIconUrl: '/icon-vacation.png',
  appleTouchIconUrl: '/apple-touch-icon.png',
  manifestUrl: '/manifest.webmanifest',
  senderEmail: 'sentinel@sentinel.example',
  senderName: SENTINEL_BRAND_NAME,
  oemActive: true,
};

// D-04: under the OEM gate an operator BRAND_* override only surfaces with a
// custom_branding entitlement. This unsigned OEM license is valid in
// NODE_ENV=test via allowUnsignedLicenses; the cache is reset around the suite
// so branding.get() re-evaluates it for the HTTP + email surfaces.
const OEM_LICENSE_PAYLOAD = JSON.stringify({
  customer: 'Sentinel OEM',
  features: ['custom_branding'],
});

// ------------------------------------------------------------------
// .hbs render helper (in-process Handlebars compile — the plan's renderMethod
// "handlebars"). Stubs the helpers/partials the templates reach for; routes the
// brand keys (brand.name / brand.nameLower) through the sentinel the SAME way
// lib/view/helpers.js does in production (brand.name -> branding.get().name,
// brand.nameLower -> .name.toLowerCase()).
// ------------------------------------------------------------------
function renderHbsSurface(relativePath) {
  const hbs = Handlebars.create();

  hbs.registerHelper('t', function(key) {
    // The production interception: brand.name / brand.nameLower resolve to the
    // dynamic brand (lib/view/helpers.js L210-215). Every other key returns a
    // neutral placeholder (its own key) — none of the i18n keys carry a vendor
    // literal, and none accidentally carry the sentinel, so the sentinel's
    // presence in the output is provably routed through the brand tokens.
    if (key === 'brand.name') { return SENTINEL_BRAND_NAME; }
    if (key === 'brand.nameLower') { return SENTINEL_BRAND_NAME.toLowerCase(); }
    return String(key);
  });
  hbs.registerHelper('brand_name', function() { return SENTINEL_BRAND_NAME; });
  hbs.registerHelper('asset', function(p) { return p; });
  hbs.registerHelper('json', function(v) {
    return JSON.stringify(v === null || v === undefined ? '' : v);
  });

  // No-op partials: every {{> partial}} the templates reference is registered so
  // a compile never throws on a missing partial. footer.hbs gates its partial in
  // {{#if logged_user}} (skipped under the anonymous context below), but
  // registering them all keeps the helper robust to a future partial addition.
  ['book_leave_modal', 'header', 'footer', 'show_flash_messages'].forEach(function(name) {
    hbs.registerPartial(name, '');
  });

  const template = hbs.compile(read(relativePath));

  const context = Object.assign({}, SENTINEL_BRANDING, {
    branding: SENTINEL_BRANDING,
    brand_name: SENTINEL_BRAND_NAME,
    body: 'sentinel-body',
    locale: 'en',
    title: '',
    custom_css: [],
    custom_java_script: [],
    team_view_full_width: false,
    disable_notifications: false,
    csrf_token: 'sentinel-csrf',
    features: {},
    logged_user: null,
    current_language_label_key: 'language.en',
    supported_language_options: [],
    primary_premium_nav_items: [],
    settings_department_premium_nav_items: [],
    settings_company_premium_nav_items: [],
    licenseStatus: {
      tone: 'positive',
      textKey: 'licenseStatus.active',
      upsellKey: 'licenseStatus.manage',
      upsellUrl: 'https://sentinel.example',
      vars: {},
    },
  });

  return template(context);
}

// ------------------------------------------------------------------
// Shared assertion: BOTH teeth on one rendered output. custom-PRESENT is
// case-insensitive (footer.hbs renders brand.nameLower; the rest render the
// mixed-case name). vendor-ABSENT runs after the D-11 namespace mask.
// ------------------------------------------------------------------
function assertBothTeeth(output, surface) {
  const masked = maskJsNamespace(output);
  expect(
    String(masked).toLowerCase(),
    'the sentinel brand must be PRESENT in the rendered output of ' + surface +
    ' (custom-PRESENT tooth — the surface must reflect the operator brand)'
  ).to.include(SENTINEL_BRAND_NAME.toLowerCase());
  expect(
    brandLiteral.test(masked),
    'a vendor literal (LeavePilot / Leave Pilot / TimeOff / timeoff.management) survived in the rendered output of ' +
    surface + ' (vendor-ABSENT tooth):\n' + masked
  ).to.equal(false);
}

describe('OEM leak surfaces: no vendor name under a custom brand', function() {

  this.timeout(30000);

  // ---- Shared HTTP boot + fixtures for the HTTP-only surfaces (iCal feed,
  // /manifest.webmanifest, login title). Modeled on t/unit/feed_branding.js:
  // boot the app under BRAND_NAME='Sentinel OEM' + an OEM license so every
  // branding.get() call inside the routes reflects the sentinel brand.
  let models;
  let company;
  let department;
  let employee;
  let employeeAgent;
  let feedToken;

  // D-06: the operator may override ANY of the 14 branding.get() fields. The
  // sentinel is therefore a FULLY-configured OEM brand — name, short name,
  // sender, AND both domains — so the rendered output proves a complete custom
  // brand leaks nothing. (The applicationDomain/promotionWebsiteDomain would
  // otherwise fall through to DEFAULT_BRANDING's http://app.timeoff.management
  // / http://timeoff.management and surface inside the D-11 namespace config
  // blob; a fully-configured operator never sees the default domains.)
  const envKeys = [
    'BRAND_NAME', 'BRAND_SHORT_NAME', 'BRAND_SENDER_NAME', 'BRAND_SENDER_EMAIL',
    'APPLICATION_DOMAIN', 'PROMOTION_WEBSITE_DOMAIN', 'LEAVEPILOT_LICENSE',
  ];
  const savedEnv = {};

  before(async function() {
    envKeys.forEach(function(key) { savedEnv[key] = process.env[key]; });

    process.env.LEAVEPILOT_LICENSE = OEM_LICENSE_PAYLOAD;
    process.env.BRAND_NAME = SENTINEL_BRAND_NAME;
    process.env.BRAND_SHORT_NAME = 'Sentinel';
    process.env.BRAND_SENDER_NAME = SENTINEL_BRAND_NAME;
    process.env.BRAND_SENDER_EMAIL = 'sentinel@sentinel.example';
    process.env.APPLICATION_DOMAIN = 'https://sentinel.example';
    process.env.PROMOTION_WEBSITE_DOMAIN = 'https://sentinel.example';
    branding.__resetOemCacheForTests();

    await httpAgent.ready();
    models = httpAgent.getApp().get('db_model');

    company = await models.Company.create({
      name: 'Leak Sentinel Company', country: 'GB', start_of_new_year: 1,
    });
    department = await models.Department.create({
      name: 'Leak Sentinel Department', companyId: company.id,
    });
    employee = await models.User.create({
      name: 'Leak', lastname: 'Sentinel', email: 'leak-sentinel@test.com',
      password: models.User.hashify_password('test123'), companyId: company.id,
      DepartmentId: department.id, activated: true,
    });
    const feed = await models.UserFeed.promise_new_feed({user: employee, type: 'calendar'});
    feedToken = feed.feed_token;

    employeeAgent = await httpAgent.agent();
  });

  after(async function() {
    envKeys.forEach(function(key) {
      if (typeof savedEnv[key] === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    });
    branding.__resetOemCacheForTests();

    if (models && employee) {
      await models.UserFeed.destroy({where: {userId: employee.id}});
      await models.User.destroy({where: {id: employee.id}});
    }
    if (models && department) {
      await models.Department.destroy({where: {id: department.id}});
    }
    if (models && company) {
      await models.Company.destroy({where: {id: company.id}});
    }
    await httpAgent.release();
  });

  // (1) SURFACES-EXIST — the watchdog cannot pass on a deleted/empty manifest
  // (env_read_invariant L221-226 "guard lost its input" shape).
  describe('surfaces-exist', function() {
    it('parses a non-empty manifest with the required arrays', function() {
      expect(manifest.dynamic, 'manifest.dynamic must be a non-empty array — the watchdog lost its input')
        .to.be.an('array').that.is.not.empty;
      expect(manifest.hardcoded, 'manifest.hardcoded must be an array').to.be.an('array');
      expect(manifest.excluded, 'manifest.excluded must be a non-empty array').to.be.an('array').that.is.not.empty;
      expect(manifest.scanStrings, 'manifest.scanStrings must be a non-empty array').to.be.an('array').that.is.not.empty;
    });
  });

  // (2) WHOLE-LIST DYNAMIC RENDER (OEM-04 — the core strengthening). ITERATE
  // EVERY manifest.dynamic entry — NOT a hardcoded subset. For each, dispatch by
  // renderMethod and assert BOTH teeth. No surface is left to a grep-only proof.
  describe('whole-list dynamic render (every surface, both teeth)', function() {

    manifest.dynamic.forEach(function(entry) {
      const label = entry.surface + ' (' + entry.lines + ')';

      it('renders ' + label + ' under the sentinel brand with custom-PRESENT and vendor-ABSENT', async function() {

        // OEM-05 suppression render proof: the license-status upsell partial is
        // GATED by {{#unless branding.oemActive}}; under oemActive:true it
        // renders nothing. The assertion is therefore NOT custom-PRESENT (the
        // section is absent by design) but upsell-ABSENT + vendor-ABSENT.
        if (entry.surface === 'views/partials/settings_company_license.hbs') {
          const output = renderHbsSurface(entry.surface);
          expect(output, 'the upsell link must be ABSENT under oemActive (OEM-05)')
            .to.not.include('license-status-link');
          expect(brandLiteral.test(output), 'the suppressed surface must carry no vendor literal')
            .to.equal(false);
          return;
        }

        let output;

        if (entry.renderMethod === 'handlebars') {
          output = renderHbsSurface(entry.surface);
        } else if (entry.renderMethod === 'email') {
          // Direct getEmailFrom() under the sentinel brand — unit-level, no HTTP
          // boot needed for this surface (the from-address is a pure function of
          // branding.get()).
          output = branding.getEmailFrom();
        } else if (entry.renderMethod === 'http') {
          // Real render via the httpAgent supertest (feed_branding.js model).
          // Dispatch by surface to the right route.
          let res;
          if (entry.surface === 'app.js') {
            res = await employeeAgent.get('/manifest.webmanifest');
          } else if (entry.surface === 'lib/route/login.js') {
            res = await employeeAgent.get('/login/');
          } else if (entry.surface === 'lib/route/feed.js') {
            expect(feedToken, 'a feed token must exist for the iCal render').to.be.a('string');
            res = await employeeAgent.get('/feed/' + feedToken + '/ical.ics');
          } else {
            throw new Error('no HTTP route mapped for manifest surface ' + entry.surface);
          }
          expect(res.status, 'HTTP surface ' + entry.surface + ' did not return 200').to.equal(200);
          output = res.text;
        } else {
          throw new Error('unknown renderMethod "' + entry.renderMethod + '" for manifest surface ' + entry.surface);
        }

        assertBothTeeth(output, entry.surface);
      });
    });
  });

  // (3) POSITIVE TEETH — the brandLiteral is non-vacuous: every vendor spelling
  // IS caught (locales_no_brand_literal.js L109-113 shape, extended with the
  // domain). If a future edit narrows the regex, one of these flips to false.
  describe('positive teeth (the regex is non-vacuous)', function() {
    manifest.scanStrings.forEach(function(s) {
      it('catches the vendor string "' + s + '"', function() {
        expect(brandLiteral.test(s), 'brandLiteral must catch "' + s + '"').to.equal(true);
      });
    });
    it('catches a vendor literal seeded inside a sentence', function() {
      expect(brandLiteral.test('log in to LeavePilot with the new settings')).to.equal(true);
      expect(brandLiteral.test('see timeoff.management for details')).to.equal(true);
    });
  });

  // (4) NEGATIVE TEETH — boundary: the generic "Time off" / "time-off" phrases
  // (space/hyphen separated) are NOT caught (locales L119-120 shape). The regex
  // demands the letters adjacent; the locale copy (e.g. "Staff Time off
  // management system") depends on this boundary.
  describe('negative teeth (the generic phrase is not caught)', function() {
    it('does NOT catch "Time off management"', function() {
      expect(brandLiteral.test('Time off management'), 'the generic "Time off" phrase must NOT be caught').to.equal(false);
    });
    it('does NOT catch "staff time-off management system"', function() {
      expect(brandLiteral.test('staff time-off management system'), 'the generic "time-off" phrase must NOT be caught').to.equal(false);
    });
  });

  // (5) HARDCODED DISPOSITION — proves the Task 1 SSO fix. The manifest's
  // hardcoded[] entry records the before/after; this asserts the AFTER state
  // holds (the surface no longer carries the vendor domain).
  describe('hardcoded disposition (SSO placeholder neutralized)', function() {
    it('the SSO client_id placeholder no longer carries the vendor domain', function() {
      const source = read('views/settings_company_authentication.hbs');
      expect(source, 'settings_company_authentication.hbs still carries placeholder="timeoff-management"')
        .to.not.include('placeholder="timeoff-management"');
      // The manifest records exactly one hardcoded entry with this disposition.
      const sso = manifest.hardcoded.find(function(h) { return h.surface === 'views/settings_company_authentication.hbs'; });
      expect(sso, 'the manifest must record the SSO hardcoded disposition').to.be.an('object');
      expect(sso.disposition, 'the disposition must be the neutral replacement').to.equal('replaced-with-neutral-placeholder');
    });
  });

  // (6) COMPANION GREP — Pitfall-5 manifest-staleness guard
  // (env_read_invariant offender + allowlist shape). The manifest cannot silently
  // go stale: every branding.get() / getEmailFrom() / brand.get( consumer in
  // lib/ or app.js MUST be declared in the manifest (dynamic[] or excluded[]),
  // or the build fails. Teeth: a manifest surface genuinely consumes branding,
  // so the allowlist is never a phantom.
  describe('companion grep: the manifest cannot go stale (Pitfall-5)', function() {

    function listJsFiles(absPath, into) {
      if (!fs.existsSync(absPath)) { return; }
      const stats = fs.statSync(absPath);
      if (stats.isDirectory()) {
        fs.readdirSync(absPath).forEach(function(child) {
          if (child === 'node_modules' || child === '.git') { return; }
          listJsFiles(path.join(absPath, child), into);
        });
        return;
      }
      if (stats.isFile() && path.extname(absPath) === '.js') {
        into.push(absPath);
      }
    }

    function collectConsumerFiles() {
      const files = [];
      ['app.js', 'lib'].forEach(function(scanned) {
        const abs = path.join(root, scanned);
        if (!fs.existsSync(abs)) { return; }
        if (fs.statSync(abs).isFile()) { files.push(abs); return; }
        listJsFiles(abs, files);
      });
      return files;
    }

    // A branding consumer call site. branding.get( / .getEmailFrom( / brand.get(.
    const CONSUMER_RE = /branding\.get\(|\.getEmailFrom\(|brand\.get\(/;

    // Normalize a manifest surface to a posix-relative file path for the
    // accounted set: strip ":line" / ":line-line" suffixes (lib/route/login.js:46
    // -> lib/route/login.js). Globs (public/js/*) and multi-file entries are left
    // as-is; neither is a lib/+app.js consumer, so they never need to match.
    function normalizeSurface(surface) {
      return String(surface).replace(/:\d+(-\d+)?$/, '');
    }

    function accountedSet() {
      const set = {};
      manifest.dynamic.forEach(function(e) { set[normalizeSurface(e.surface)] = true; });
      manifest.excluded.forEach(function(e) { set[normalizeSurface(e.surface)] = true; });
      return set;
    }

    it('has consumer files to scan (surfaces-exist)', function() {
      // A companion grep whose scanned paths resolve to no files is green for
      // the wrong reason. lib/ + app.js hold many .js files today.
      expect(collectConsumerFiles().length, 'the companion grep lost its input').to.be.above(20);
    });

    it('every branding.get()/getEmailFrom() consumer is declared in the manifest', function() {
      const accounted = accountedSet();
      const offenders = [];
      collectConsumerFiles().forEach(function(absFile) {
        const rel = path.relative(root, absFile).split(path.sep).join('/');
        if (CONSUMER_RE.test(read(rel)) && !accounted[rel]) {
          offenders.push(rel);
        }
      });
      expect(
        offenders,
        'these files consume branding.get()/getEmailFrom()/brand.get() but are NOT in the manifest ' +
        '(dynamic[] or excluded[]) — the manifest has gone stale; add them or document the exclusion:\n' +
        offenders.join('\n')
      ).to.deep.equal([]);
    });

    // Teeth (env_read_invariant L242-264 allowlist-non-vacuous shape): a manifest
    // surface genuinely contains a branding.get()/getEmailFrom() call in source,
    // so the manifest cannot list phantom surfaces and the consumer scan finds
    // real consumers. lib/email.js is a dynamic[] entry with 13 getEmailFrom()
    // call sites — the canonical proof.
    it('a manifest dynamic surface genuinely consumes branding (allowlist is not a phantom)', function() {
      const emailSource = read('lib/email.js');
      expect(
        /branding\.getEmailFrom\(|branding\.get\(/.test(emailSource),
        'lib/email.js (a dynamic manifest surface) no longer consumes branding — the allowlist guards nothing'
      ).to.equal(true);
    });
  });
});
