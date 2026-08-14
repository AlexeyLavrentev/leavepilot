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
