'use strict';

var expect = require('chai').expect;
var branding = require('../../lib/branding');

// D-04: without the custom_branding entitlement the operator's BRAND_* config
// is IGNORED and DEFAULT_BRANDING is returned. The override tests below set
// BRAND_* and assert the override surfaces, so they now need an unsigned OEM
// license carrying the entitlement (valid in NODE_ENV=test via
// allowUnsignedLicenses, features.js L277-292). The default-brand tests set no
// license and keep expecting LeavePilot. The license env + the OEM cache are
// snapshotted/restored and the cache is reset in beforeEach so the cases are
// order-independent.
var OEM_LICENSE_PAYLOAD = JSON.stringify({
  customer: 'Test OEM',
  features: ['custom_branding'],
});

describe('Branding', function() {
  var originalEnv = {};

  beforeEach(function() {
    originalEnv = {
      BRAND_NAME : process.env.BRAND_NAME,
      BRAND_SHORT_NAME : process.env.BRAND_SHORT_NAME,
      APPLICATION_DOMAIN : process.env.APPLICATION_DOMAIN,
      PROMOTION_WEBSITE_DOMAIN : process.env.PROMOTION_WEBSITE_DOMAIN,
      BRAND_LOGO_URL : process.env.BRAND_LOGO_URL,
      BRAND_FAVICON_URL : process.env.BRAND_FAVICON_URL,
      BRAND_FAVICON_PNG_32_URL : process.env.BRAND_FAVICON_PNG_32_URL,
      BRAND_APP_ICON_URL : process.env.BRAND_APP_ICON_URL,
      BRAND_MANIFEST_URL : process.env.BRAND_MANIFEST_URL,
      BRAND_SENDER_EMAIL : process.env.BRAND_SENDER_EMAIL,
      BRAND_SENDER_NAME : process.env.BRAND_SENDER_NAME,
      BRAND_EMAIL_FROM : process.env.BRAND_EMAIL_FROM,
      LEAVEPILOT_LICENSE : process.env.LEAVEPILOT_LICENSE,
    };
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

  it('returns default branding from app config', function() {
    var currentBranding = branding.get();

    expect(currentBranding.name).to.equal('LeavePilot');
    expect(currentBranding.shortName).to.equal('LeavePilot');
    expect(currentBranding.applicationDomain).to.equal('http://app.timeoff.management');
    expect(currentBranding.promotionWebsiteDomain).to.equal('http://timeoff.management');
    expect(currentBranding.faviconUrl).to.equal('/favicon.ico');
    expect(currentBranding.emailFrom).to.equal('email@test.com');
  });

  it('lets environment variables override customer branding', function() {
    process.env.LEAVEPILOT_LICENSE = OEM_LICENSE_PAYLOAD;
    process.env.BRAND_NAME = 'Acme Leave';
    process.env.BRAND_SHORT_NAME = 'Acme';
    process.env.APPLICATION_DOMAIN = 'https://leave.example.com';
    process.env.PROMOTION_WEBSITE_DOMAIN = 'https://example.com';
    process.env.BRAND_LOGO_URL = 'https://cdn.example.com/logo.svg';
    process.env.BRAND_FAVICON_URL = 'https://cdn.example.com/favicon.ico';

    var currentBranding = branding.get();

    expect(currentBranding.name).to.equal('Acme Leave');
    expect(currentBranding.shortName).to.equal('Acme');
    expect(currentBranding.applicationDomain).to.equal('https://leave.example.com');
    expect(currentBranding.promotionWebsiteDomain).to.equal('https://example.com');
    expect(currentBranding.logoUrl).to.equal('https://cdn.example.com/logo.svg');
    expect(currentBranding.faviconUrl).to.equal('https://cdn.example.com/favicon.ico');
  });

  it('formats email sender from branding values', function() {
    process.env.LEAVEPILOT_LICENSE = OEM_LICENSE_PAYLOAD;
    process.env.BRAND_SENDER_EMAIL = 'leave@example.com';
    process.env.BRAND_SENDER_NAME = 'Acme Leave';

    expect(branding.getEmailFrom()).to.equal('"Acme Leave" <leave@example.com>');
  });

  it('allows a fully custom email sender value', function() {
    process.env.LEAVEPILOT_LICENSE = OEM_LICENSE_PAYLOAD;
    process.env.BRAND_EMAIL_FROM = 'No Reply <noreply@example.com>';

    expect(branding.getEmailFrom()).to.equal('No Reply <noreply@example.com>');
  });

  /*
    BRAND-04 "surfaces rebrand without code edit". The /manifest.webmanifest
    route (app.js:95-117) builds the web manifest from branding.get() — these
    specs pin that an operator override of the manifest-relevant fields flows
    through branding.get() with no code change, and that the defaults match the
    LeavePilot surfaces the route renders today.
  */
  it('lets manifest-route fields rebrand via BRAND_* override', function() {
    process.env.LEAVEPILOT_LICENSE = OEM_LICENSE_PAYLOAD;
    process.env.BRAND_NAME = 'Acme';
    process.env.BRAND_SHORT_NAME = 'A';
    process.env.BRAND_FAVICON_PNG_32_URL = 'https://cdn/acme-32.png';
    process.env.BRAND_APP_ICON_URL = 'https://cdn/acme-icon.png';
    process.env.BRAND_MANIFEST_URL = '/acme-manifest.webmanifest';

    var currentBranding = branding.get();

    expect(currentBranding.name).to.equal('Acme');
    expect(currentBranding.shortName).to.equal('A');
    expect(currentBranding.faviconPng32Url).to.equal('https://cdn/acme-32.png');
    expect(currentBranding.appIconUrl).to.equal('https://cdn/acme-icon.png');
    expect(currentBranding.manifestUrl).to.equal('/acme-manifest.webmanifest');
  });

  it('exposes LeavePilot manifest defaults when no override is set', function() {
    var currentBranding = branding.get();

    expect(currentBranding.faviconPng32Url).to.equal('/favicon-32x32.png');
    expect(currentBranding.appIconUrl).to.equal('/icon-vacation.png');
    expect(currentBranding.manifestUrl).to.equal('/manifest.webmanifest');
  });

  it('getEmailFrom returns the bare sender address under the default brand', function() {
    // Locks the email surface as a branding consumer via the dedicated accessor
    // (the .emailFrom property check above is the same value reached another way;
    // this asserts getEmailFrom() itself stays wired to branding.get()).
    expect(branding.getEmailFrom()).to.equal('email@test.com');
  });
});
