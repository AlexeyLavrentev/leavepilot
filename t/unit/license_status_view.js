'use strict';

/*
  Mapper watchdog for the license-status line (FUNNEL-01/02/03, CONTEXT D-04/D-09).

  lib/license_status_view.js mapLicenseStatusToUiBucket(status, branding) is the
  single place that decides which UI bucket an admin sees, so it is unit-tested
  exhaustively: one fixture per bucket in the mapper's branch order, the D-09
  invariant (a portal short-term enterprise license is NOT a separate bucket —
  it flows through the normal active/expiring path), and a no-hardcoded-literal
  tooth proving the upsell URL flows from the injected branding rather than a
  literal. A surface-exists assertion guards against the mapper or its export
  being deleted (mirrors the license_consistency.js "guard lost its input"
  shape). The static-source check makes a future short-term-license branch loud.
*/

const fs = require('fs');
const path = require('path');
const expect = require('chai').expect;

const mapper = require('../../lib/license_status_view');
const mapLicenseStatusToUiBucket = mapper.mapLicenseStatusToUiBucket;

// Sentinel branding: a unique promotionWebsiteDomain proves the upsell URL is
// routed from branding.get() (never a hardcoded literal), and a distinct name
// proves no returned key carries the brand name.
const SENTINEL_BRANDING = {
  name: 'Teeth Brand',
  promotionWebsiteDomain: 'https://sentinel.example',
};

describe('license_status_view: status -> UI bucket mapper', function() {

  describe('surface exists', function() {
    it('exports mapLicenseStatusToUiBucket as a function', function() {
      // "the guard lost its input" — the spec cannot pass by deleting the mapper.
      expect(mapLicenseStatusToUiBucket, 'lib/license_status_view.js no longer exports the mapper').to.be.a('function');
    });

    it('exports the EXPIRING_THRESHOLD_DAYS constant (60)', function() {
      expect(mapper.EXPIRING_THRESHOLD_DAYS).to.equal(60);
    });
  });

  describe('maps every status shape to the correct UI bucket (D-04 branch order)', function() {

    it('source none -> community / neutral', function() {
      const r = mapLicenseStatusToUiBucket(
        {source: 'none', valid: false, reason: 'missing'},
        SENTINEL_BRANDING
      );
      expect(r.tone).to.equal('neutral');
      expect(r.textKey).to.equal('licenseStatus.community');
      expect(r.upsellKey).to.equal('licenseStatus.upsellCommunity');
      expect(r.vars.brand, 'community carries the brand name for the copy').to.equal('Teeth Brand');
    });

    it('revoked -> revoked / negative', function() {
      const r = mapLicenseStatusToUiBucket(
        {valid: false, reason: 'revoked', source: 'env'},
        SENTINEL_BRANDING
      );
      expect(r.tone).to.equal('negative');
      expect(r.textKey).to.equal('licenseStatus.revoked');
      expect(r.upsellKey).to.equal('licenseStatus.upsellContact');
    });

    it('invalid signature -> error / negative (reason exposed to the admin)', function() {
      const r = mapLicenseStatusToUiBucket(
        {valid: false, reason: 'invalid_signature', source: 'env'},
        SENTINEL_BRANDING
      );
      expect(r.tone).to.equal('negative');
      expect(r.textKey).to.equal('licenseStatus.error');
      expect(r.upsellKey).to.equal('licenseStatus.upsellCommunity');
      expect(r.vars.reason).to.equal('invalid_signature');
    });

    it('unsigned not allowed -> the same error bucket (FUNNEL-02 collapses reasons)', function() {
      const r = mapLicenseStatusToUiBucket(
        {valid: false, reason: 'unsigned_not_allowed', source: 'env'},
        SENTINEL_BRANDING
      );
      expect(r.tone).to.equal('negative');
      expect(r.textKey).to.equal('licenseStatus.error');
      expect(r.vars.reason).to.equal('unsigned_not_allowed');
    });

    it('in grace -> grace / warning (premium still works until graceEndsAt)', function() {
      const r = mapLicenseStatusToUiBucket(
        {valid: true, inGrace: true, reason: 'expired', source: 'env', expires: '2026-12-01', graceEndsAt: '2026-12-15'},
        SENTINEL_BRANDING
      );
      expect(r.tone).to.equal('warning');
      expect(r.textKey).to.equal('licenseStatus.grace');
      expect(r.upsellKey).to.equal('licenseStatus.upsellRenew');
      expect(r.vars.expires).to.equal('2026-12-01');
      expect(r.vars.graceEndsAt).to.equal('2026-12-15');
    });

    it('expired past grace -> expired / negative', function() {
      const r = mapLicenseStatusToUiBucket(
        {valid: false, reason: 'expired', source: 'env', inGrace: false},
        SENTINEL_BRANDING
      );
      expect(r.tone).to.equal('negative');
      expect(r.textKey).to.equal('licenseStatus.expired');
      expect(r.upsellKey).to.equal('licenseStatus.upsellRenew');
    });

    it('valid within the threshold -> expiring / warning', function() {
      const r = mapLicenseStatusToUiBucket(
        {valid: true, reason: 'valid', source: 'env', daysUntilExpiry: 30, expires: '2026-12-01'},
        SENTINEL_BRANDING
      );
      expect(r.tone).to.equal('warning');
      expect(r.textKey).to.equal('licenseStatus.expiring');
      expect(r.upsellKey).to.equal('licenseStatus.upsellRenew');
      expect(r.vars.days).to.equal(30);
    });

    it('valid beyond the threshold -> active / positive', function() {
      const r = mapLicenseStatusToUiBucket(
        {valid: true, reason: 'valid', source: 'env', plan: 'pro', daysUntilExpiry: 100},
        SENTINEL_BRANDING
      );
      expect(r.tone).to.equal('positive');
      expect(r.textKey).to.equal('licenseStatus.active');
      expect(r.upsellKey).to.equal('licenseStatus.manage');
      expect(r.vars.plan).to.equal('pro');
    });
  });

  describe('D-09: a portal short-term enterprise license is never a separate bucket', function() {
    // Portal-issued short-term licenses carry plan:'enterprise' with no marker in
    // the signed payload (CONTEXT D-09), so they are indistinguishable from a
    // paid enterprise license at this layer. They flow through the normal
    // valid-license path — active when beyond the threshold, expiring when within
    // it (the countdown is covered by the existing expiring path) — and NEVER
    // produce a dedicated short-term-license bucket.

    it('classifies as active (positive) when it has runway beyond the threshold', function() {
      const r = mapLicenseStatusToUiBucket(
        {valid: true, reason: 'valid', source: 'env', plan: 'enterprise', daysUntilExpiry: 90, inGrace: false, expires: '2026-12-01', graceEndsAt: null},
        SENTINEL_BRANDING
      );
      expect(r.textKey).to.equal('licenseStatus.active');
      expect(r.tone).to.equal('positive');
      expect(r.textKey, 'no dedicated short-term-license bucket exists').to.not.equal('licenseStatus.trial');
    });

    it('classifies as expiring (warning) within the threshold — the realistic ~30-day case', function() {
      // A real portal short-term license is ~30 days, so it always lands inside
      // the 60-day expiring window. Rendering it via the expiring path is the
      // intended D-09 behaviour (RESEARCH Q1), not a bug.
      const r = mapLicenseStatusToUiBucket(
        {valid: true, reason: 'valid', source: 'env', plan: 'enterprise', daysUntilExpiry: 25, inGrace: false, expires: '2026-12-01', graceEndsAt: null},
        SENTINEL_BRANDING
      );
      expect(r.textKey).to.equal('licenseStatus.expiring');
      expect(r.tone).to.equal('warning');
      expect(r.textKey, 'no dedicated short-term-license bucket exists').to.not.equal('licenseStatus.trial');
    });

    it('has no short-term-license branch in the source (static guard)', function() {
      // A scoped source check, not a behaviour claim: the mapper source carries
      // no token naming a dedicated short-term-license branch, so reintroducing
      // one is loud. The module must also not export a plan-classifier.
      const source = fs.readFileSync(
        path.join(__dirname, '..', '..', 'lib', 'license_status_view.js'),
        'utf8'
      );
      expect(
        source.toLowerCase(),
        'lib/license_status_view.js reintroduced a dedicated short-term-license branch (token "trial")'
      ).to.not.include('trial');
      expect(mapper, 'the module must not export a plan classifier').to.not.have.property('isTrialPlan');
    });
  });

  describe('no hardcoded brand or URL literal (the upsell URL flows from branding)', function() {
    const LITERAL_PATTERN = /LeavePilot|timeoff|https?:\/\//i;

    const bucketFixtures = [
      {label: 'community', status: {source: 'none', valid: false, reason: 'missing'}},
      {label: 'revoked', status: {valid: false, reason: 'revoked', source: 'env'}},
      {label: 'error', status: {valid: false, reason: 'invalid_signature', source: 'env'}},
      {label: 'grace', status: {valid: true, inGrace: true, reason: 'expired', source: 'env', expires: 'x', graceEndsAt: 'y'}},
      {label: 'expired', status: {valid: false, reason: 'expired', source: 'env', inGrace: false}},
      {label: 'expiring', status: {valid: true, reason: 'valid', source: 'env', daysUntilExpiry: 30, expires: 'x'}},
      {label: 'active', status: {valid: true, reason: 'valid', source: 'env', plan: 'pro', daysUntilExpiry: 100}},
    ];

    bucketFixtures.forEach(function(fixture) {
      it('routes the sentinel upsell URL through every bucket (' + fixture.label + ')', function() {
        const r = mapLicenseStatusToUiBucket(fixture.status, SENTINEL_BRANDING);
        // The URL is routed from branding.promotionWebsiteDomain, never a literal.
        expect(r.upsellUrl, 'upsellUrl must equal the injected branding value').to.equal('https://sentinel.example');
        // No returned key carries a brand or URL literal.
        expect(LITERAL_PATTERN.test(r.textKey), r.textKey + ' carries a brand/URL literal').to.equal(false);
        expect(LITERAL_PATTERN.test(r.upsellKey), r.upsellKey + ' carries a brand/URL literal').to.equal(false);
      });
    });

    it('returns an empty upsell URL when branding has no promotion domain', function() {
      const r = mapLicenseStatusToUiBucket(
        {source: 'none', valid: false, reason: 'missing'},
        {name: 'No Domain Brand'}
      );
      expect(r.upsellUrl).to.equal('');
    });
  });
});
