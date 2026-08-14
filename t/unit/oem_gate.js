'use strict';

/*
  OEM tracer end-to-end proof (Plan 04-01 Task 2).

  Three concerns, one file:
  1. HAPPY PATH — a valid non-grace license carrying custom_branding yields
     branding.get().oemActive === true AND the operator's configured brand
     surfaces (D-04: entitled + configured -> custom brand).
  2. DEFAULT PATH — no license yields oemActive === false AND name ===
     'LeavePilot' (D-04: operator BRAND_* env and config ignored without
     entitlement).
  3. SUPPRESSION RENDER — under oemActive the entire upsell section in
     views/partials/settings_company_license.hbs is ABSENT from the rendered
     output (OEM-05 / D-07: ONE {{#unless branding.oemActive}} gates the
     section); under !oemActive it renders as today.

  License outcomes are injected by setting LEAVEPILOT_LICENSE (unsigned payloads
  are valid in NODE_ENV=test via allowUnsignedLicenses, features.js L277-292),
  and the memoized entitlement cache is reset between cases so they are
  order-independent.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const Handlebars = require('handlebars');

const branding = require('../../lib/branding');

const root = path.join(__dirname, '..', '..');
const partialPath = path.join(root, 'views', 'partials', 'settings_company_license.hbs');
const partialSource = fs.readFileSync(partialPath, 'utf8');

const OEM_LICENSE_PAYLOAD = JSON.stringify({
  customer: 'Test OEM',
  features: ['custom_branding'],
});

// Compile the partial on an isolated Handlebars instance with {{t}} stubbed to
// its key, so the assertions target the section/link HTML (the literal class
// names and href in the partial), not locale copy or the app's full helper
// registry. {{t key brand=.. plan=..}} -> returns the key positional.
function renderLicenseSection(context) {
  const hbs = Handlebars.create();
  hbs.registerHelper('t', function(key) {
    return key;
  });
  return hbs.compile(partialSource)(context);
}

// A licenseStatus bucket with a non-empty upsellUrl so the upsell link WOULD
// render unless the whole section is suppressed by the oemActive guard.
const bucketWithUpsell = {
  tone: 'neutral',
  textKey: 'licenseStatus.community',
  upsellKey: 'licenseStatus.upsellCommunity',
  upsellUrl: 'https://promotion.example/buy',
  vars: {},
};

describe('OEM gate tracer (Plan 04-01)', function() {
  const originalEnv = {};

  beforeEach(function() {
    originalEnv.LEAVEPILOT_LICENSE = process.env.LEAVEPILOT_LICENSE;
    originalEnv.BRAND_NAME = process.env.BRAND_NAME;
    branding.__resetOemCacheForTests();
  });

  afterEach(function() {
    Object.keys(originalEnv).forEach(function(key) {
      if (typeof originalEnv[key] === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });
    branding.__resetOemCacheForTests();
  });

  describe('happy path: a valid custom_branding license activates the custom brand', function() {
    it('sets oemActive true and surfaces the configured brand name', function() {
      process.env.LEAVEPILOT_LICENSE = OEM_LICENSE_PAYLOAD;
      process.env.BRAND_NAME = 'Acme OEM';
      branding.__resetOemCacheForTests();

      const current = branding.get();
      expect(current.oemActive, 'entitled + configured -> oemActive true').to.equal(true);
      expect(current.name, 'the operator custom brand surfaces').to.equal('Acme OEM');
    });
  });

  describe('default path: no license yields the default brand', function() {
    it('sets oemActive false and returns LeavePilot', function() {
      delete process.env.LEAVEPILOT_LICENSE;
      branding.__resetOemCacheForTests();

      const current = branding.get();
      expect(current.oemActive, 'no entitlement -> oemActive false').to.equal(false);
      expect(current.name, 'D-04: operator config ignored without entitlement').to.equal('LeavePilot');
    });
  });

  describe('suppression: the upsell section in settings_company_license.hbs', function() {
    it('is ABSENT from the rendered output under oemActive (OEM-05 / D-07)', function() {
      const html = renderLicenseSection({
        branding: {oemActive: true, name: 'Acme OEM'},
        licenseStatus: bucketWithUpsell,
      });

      expect(html, 'no section class under OEM').to.not.contain('general-settings-license');
      expect(html, 'no upsell link under OEM').to.not.contain('license-status-link');
      expect(html, 'no upsell href under OEM').to.not.contain('https://promotion.example/buy');
    });

    it('renders as today when oemActive is false', function() {
      const html = renderLicenseSection({
        branding: {oemActive: false, name: 'LeavePilot'},
        licenseStatus: bucketWithUpsell,
      });

      expect(html, 'the section is present without OEM').to.contain('general-settings-license');
      expect(html, 'the upsell link is present without OEM').to.contain('license-status-link');
      expect(html, 'the upsell href flows from the bucket').to.contain('https://promotion.example/buy');
    });
  });
});

/*
  ---------------------------------------------------------------------------
  Plan 04-02 — OEM-02 outcome matrix + OEM-01 non-cumulative proof (APPENDED).
  The tracer concerns above are unchanged; what follows proves the 04-01 gate
  EXHAUSTIVELY across every license state and tier. Every outcome is evaluated
  in a FRESH child process so the memoized getOemEntitlement() cache (process-
  stable per Plan 04-01) cannot leak a prior fixture's decision forward.
  ---------------------------------------------------------------------------
*/

// runNode model: t/unit/edition_community_boundary.js L34-40. The child sets
// LEAVEPILOT_LICENSE + BRAND_NAME, resets the cache, calls branding.get(), and
// prints JSON. execFileSync throws on a non-zero child exit, so a returned,
// parseable result is itself the OEM-02 "never throws" proof for that outcome
// (a throw out of branding.get() would crash the child and fail the test).
function runBrandingOutcome(licenseValue, brandName) {
  const childEnv = Object.assign({}, process.env);
  // Force a deterministic license for this outcome. Delete BOTH the canonical
  // (LEAVEPILOT_) and eternal-alias (TIMEOFF_) names so a value inherited from
  // the parent cannot grant OEM in the "missing" case (D-15 alias shim).
  delete childEnv.LEAVEPILOT_LICENSE;
  delete childEnv.TIMEOFF_LICENSE;
  if (licenseValue !== null) {
    childEnv.LEAVEPILOT_LICENSE = licenseValue;
  }
  childEnv.BRAND_NAME = brandName;

  const script = [
    "const branding = require('./lib/branding');",
    "branding.__resetOemCacheForTests();",
    "const b = branding.get();",
    "process.stdout.write(JSON.stringify({ok: true, oemActive: b.oemActive, name: b.name}));",
  ].join('');

  return JSON.parse(childProcess.execFileSync(process.execPath, ['-e', script], {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
  }).trim());
}

// Prints features.getLicenseStatus() for a fixture so a teeth test can prove a
// fixture GENUINELY lands in its intended state (e.g. the grace fixture is
// valid:true + inGrace:true) — keeping the oemActive assertion non-vacuous.
function runLicenseStatusFor(licenseValue) {
  const childEnv = Object.assign({}, process.env);
  delete childEnv.LEAVEPILOT_LICENSE;
  delete childEnv.TIMEOFF_LICENSE;
  if (licenseValue !== null) {
    childEnv.LEAVEPILOT_LICENSE = licenseValue;
  }

  const script = [
    "const features = require('./lib/features');",
    "const s = features.getLicenseStatus();",
    "process.stdout.write(JSON.stringify({valid: !!s.valid, inGrace: !!s.inGrace, reason: s.reason, features: s.features}));",
  ].join('');

  return JSON.parse(childProcess.execFileSync(process.execPath, ['-e', script], {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
  }).trim());
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDaysFromNow = days => new Date(Date.now() + days * DAY_MS).toISOString();

// Five OEM-02 outcome fixtures, each a REAL shape features.getLicenseStatus()
// produces (unsigned payloads are valid in NODE_ENV=test via allowUnsignedLicenses).
// BRAND_NAME='Marker' is set for every outcome: valid_entitled proves the
// configured brand SURFACES, every other case proves operator config is IGNORED
// without entitlement (D-04).
const OUTCOMES = {
  valid_entitled: {
    label: 'valid + entitled (custom_branding present, not in grace)',
    license: JSON.stringify({
      customer: 'OEM Matrix',
      features: ['custom_branding', 'ldap_authentication'],
    }),
    expectOemActive: true,
    expectName: 'Marker',
  },
  missing: {
    label: 'missing (no LEAVEPILOT_LICENSE / source none)',
    license: null,
    expectOemActive: false,
    expectName: 'LeavePilot',
  },
  damaged: {
    label: 'damaged (malformed LEAVEPILOT_LICENSE -> invalid_format)',
    license: '{ this is not a parseable license envelope',
    expectOemActive: false,
    expectName: 'LeavePilot',
  },
  expired: {
    label: 'expired (expires 30 days ago, beyond the 14-day grace window)',
    license: JSON.stringify({
      customer: 'OEM Matrix',
      features: ['custom_branding'],
      expiresAt: isoDaysFromNow(-30),
    }),
    expectOemActive: false,
    expectName: 'LeavePilot',
  },
  grace: {
    // GRACE TRAP (D-03): grace sets valid:true + inGrace:true. The gate's
    // explicit !status.inGrace term MUST keep oemActive:false so the 14-day
    // premium grace window can never bleed OEM. Load-bearing tooth.
    label: 'grace (expired 1 day ago, INSIDE the grace window -> GRACE TRAP)',
    license: JSON.stringify({
      customer: 'OEM Matrix',
      features: ['custom_branding'],
      expiresAt: isoDaysFromNow(-1),
    }),
    expectOemActive: false,
    expectName: 'LeavePilot',
  },
};

describe('OEM-02 outcome matrix: every license state resolves through branding.get() and never throws (Plan 04-02)', function() {
  this.timeout(10000);

  Object.keys(OUTCOMES).forEach(function(key) {
    const fixture = OUTCOMES[key];

    it('resolves the "' + key + '" outcome — ' + fixture.label, function() {
      // A returned, parseable result means the subprocess exited 0 (no throw
      // out of branding.get()); result.ok makes that OEM-02 proof explicit.
      const result = runBrandingOutcome(fixture.license, 'Marker');

      expect(result.ok, key + ': subprocess completed branding.get() without throwing').to.equal(true);
      expect(result.oemActive, key + ' -> oemActive').to.equal(fixture.expectOemActive);
      expect(result.name, key + ' -> brand name').to.equal(fixture.expectName);
    });
  });

  it('pins the GRACE TRAP (D-03 / expired_in_grace): valid+inGrace still yields oemActive false', function() {
    // Restated as its own named tooth so a future regression of the !inGrace
    // term in the gate is loud, independent of the table-driven grace row.
    const result = runBrandingOutcome(OUTCOMES.grace.license, 'Marker');
    expect(result.ok, 'no throw out of branding.get() under grace').to.equal(true);
    expect(result.oemActive, 'GRACE TRAP: valid+inGrace MUST NOT grant OEM').to.equal(false);
    expect(result.name, 'operator brand ignored under the grace fallback').to.equal('LeavePilot');
  });
});

describe('GRACE TRAP teeth: the grace fixture genuinely lands in grace (non-vacuous proof)', function() {
  this.timeout(10000);

  it('the grace license evaluates to valid:true + inGrace:true + custom_branding, so oemActive:false can only come from the gate !inGrace term', function() {
    const status = runLicenseStatusFor(OUTCOMES.grace.license);
    expect(status.valid, 'grace fixture IS a valid license').to.equal(true);
    expect(status.inGrace, 'grace fixture IS inside the grace window').to.equal(true);
    expect(status.reason).to.equal('expired_in_grace');
    expect(status.features, 'grace fixture carries the custom_branding entitlement').to.include('custom_branding');
  });
});

describe('OEM-01 non-cumulative (D-01): an enterprise tier does NOT grant custom_branding (Plan 04-02)', function() {
  this.timeout(10000);

  it('a broad enterprise license WITHOUT custom_branding yields oemActive false and the default brand even with a configured custom brand', function() {
    // D-01: custom_branding is a separate OEM tariff, not bundled into a higher
    // enterprise tier. A paying enterprise customer cannot white-label without
    // the separate OEM entitlement. Run in a child process so the memoized
    // cache from any earlier in-process OEM decision cannot grant OEM here.
    const enterpriseLicense = JSON.stringify({
      customer: 'Enterprise Co',
      features: [
        'sso_authentication',
        'integration_api',
        'employee_groups',
        'work_calendars',
        'leave_start_reminders',
      ],
    });

    const result = runBrandingOutcome(enterpriseLicense, 'Partner Brand');

    expect(result.ok, 'no throw out of branding.get() for an enterprise license').to.equal(true);
    expect(result.oemActive, 'enterprise tier WITHOUT custom_branding MUST NOT grant OEM (D-01 non-cumulative)').to.equal(false);
    expect(result.name, "operator's custom brand ignored — enterprise is not OEM").to.equal('LeavePilot');
  });
});

describe('OEM-01 non-cumulative teeth: the enterprise fixture is a VALID license that simply lacks custom_branding (non-vacuous proof)', function() {
  this.timeout(10000);

  it('the enterprise license is valid + not in grace + has NO custom_branding, so oemActive:false is genuinely the missing entitlement (D-01)', function() {
    const enterpriseLicense = JSON.stringify({
      customer: 'Enterprise Co',
      features: [
        'sso_authentication',
        'integration_api',
        'employee_groups',
        'work_calendars',
        'leave_start_reminders',
      ],
    });

    const status = runLicenseStatusFor(enterpriseLicense);
    expect(status.valid, 'enterprise fixture IS a valid license').to.equal(true);
    expect(status.inGrace, 'enterprise fixture is NOT in grace').to.equal(false);
    expect(status.features, 'enterprise fixture carries real enterprise features').to.include('sso_authentication');
    expect(status.features, 'enterprise fixture does NOT carry custom_branding (the OEM tariff)').to.not.include('custom_branding');
  });
});
