'use strict';

const crypto = require('crypto');
const expect = require('chai').expect;

const config = require('../../lib/config');
const features = require('../../lib/features');

describe('Feature licensing', function() {
  const originalEnv = {};
  // Every prefixed key is listed in BOTH generations: the CI coverage
  // contour exports the canonical LEAVEPILOT_* names, and envResolver lets
  // the canonical generation win - clearing only the legacy TIMEOFF_* names
  // leaked the ambient switch into the licensing specs below.
  const envKeys = [
    'NODE_ENV',
    'TIMEOFF_EDITION',
    'LEAVEPILOT_EDITION',
    'TIMEOFF_FEATURES',
    'LEAVEPILOT_FEATURES',
    'TIMEOFF_LICENSE',
    'LEAVEPILOT_LICENSE',
    'TIMEOFF_LICENSE_SECRET',
    'LEAVEPILOT_LICENSE_SECRET',
    'TIMEOFF_LICENSE_PUBLIC_KEY',
    'LEAVEPILOT_LICENSE_PUBLIC_KEY',
    'FEATURE_TIME_BALANCE',
    'ALLOW_UNLICENSED_FEATURE_OVERRIDES',
    'ALLOW_UNSIGNED_LICENSES',
    'ALLOW_CONFIG_LICENSED_FEATURES',
    'TIMEOFF_LICENSE_PUBLIC_KEYS',
    'LEAVEPILOT_LICENSE_PUBLIC_KEYS',
    'TIMEOFF_LICENSE_GRACE_DAYS',
    'LEAVEPILOT_LICENSE_GRACE_DAYS',
    'TIMEOFF_LICENSE_REVOCATION_LIST',
    'LEAVEPILOT_LICENSE_REVOCATION_LIST',
    'TIMEOFF_LICENSE_REVOCATION_PUBLIC_KEY',
    'LEAVEPILOT_LICENSE_REVOCATION_PUBLIC_KEY',
  ];
  const originalConfig = {
    licensedFeatures: config.get('licensed_features'),
    featureOverrides: config.get('features'),
    allowUnlicensedFeatureOverrides: config.get('allow_unlicensed_feature_overrides'),
    allowUnsignedLicenses: config.get('allow_unsigned_licenses'),
    licenseSecret: config.get('license_secret'),
    licensePublicKey: config.get('license_public_key'),
    allowConfigLicensedFeatures: config.get('allow_config_licensed_features'),
  };

  beforeEach(function() {
    envKeys.forEach(key => {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    });

    config.set('licensed_features', []);
    config.set('features', {});
    config.set('allow_unlicensed_feature_overrides', undefined);
    config.set('allow_unsigned_licenses', undefined);
    config.set('license_secret', undefined);
    config.set('license_public_key', undefined);
    config.set('allow_config_licensed_features', undefined);
    features.registerFeature('time_balance');
    features.registerFeature('vacation_planning');
  });

  afterEach(function() {
    envKeys.forEach(key => {
      if (typeof originalEnv[key] === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });

    config.set('licensed_features', originalConfig.licensedFeatures);
    config.set('features', originalConfig.featureOverrides);
    config.set('allow_unlicensed_feature_overrides', originalConfig.allowUnlicensedFeatureOverrides);
    config.set('allow_unsigned_licenses', originalConfig.allowUnsignedLicenses);
    config.set('license_secret', originalConfig.licenseSecret);
    config.set('license_public_key', originalConfig.licensePublicKey);
    config.set('allow_config_licensed_features', originalConfig.allowConfigLicensedFeatures);
  });

  it('allows TIMEOFF_FEATURES outside production-like environments', function() {
    process.env.NODE_ENV = 'test';
    process.env.TIMEOFF_FEATURES = 'time_balance';

    expect(features.isEnabled('time_balance')).to.equal(true);
  });

  it('ignores unlicensed TIMEOFF_FEATURES in production-like environments', function() {
    process.env.NODE_ENV = 'production';
    process.env.TIMEOFF_FEATURES = 'time_balance';

    expect(features.isEnabled('time_balance')).to.equal(false);
  });

  it('ignores unlicensed overrides in commercial edition outside production', function() {
    process.env.NODE_ENV = 'development';
    process.env.TIMEOFF_EDITION = 'commercial';
    process.env.TIMEOFF_FEATURES = 'time_balance';
    process.env.ALLOW_UNLICENSED_FEATURE_OVERRIDES = 'true';
    process.env.FEATURE_TIME_BALANCE = 'true';

    expect(features.isEnabled('time_balance')).to.equal(false);
  });

  it('rejects unsigned licenses in commercial edition outside production', function() {
    process.env.NODE_ENV = 'development';
    process.env.TIMEOFF_EDITION = 'commercial';
    process.env.ALLOW_UNSIGNED_LICENSES = 'true';
    process.env.TIMEOFF_LICENSE = JSON.stringify({features: ['time_balance']});

    expect(features.isEnabled('time_balance')).to.equal(false);
  });

  it('ignores config licensed features in production-like environments by default', function() {
    process.env.NODE_ENV = 'production';
    config.set('licensed_features', ['time_balance']);

    expect(features.isEnabled('time_balance')).to.equal(false);
  });

  it('does not allow config licensed features to bypass production licensing', function() {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_CONFIG_LICENSED_FEATURES = 'true';
    config.set('licensed_features', ['time_balance']);

    expect(features.isEnabled('time_balance')).to.equal(false);
  });

  it('ignores unsigned TIMEOFF_LICENSE payloads in production-like environments', function() {
    process.env.NODE_ENV = 'production';
    process.env.TIMEOFF_LICENSE = JSON.stringify({
      features: ['time_balance'],
    });

    expect(features.isEnabled('time_balance')).to.equal(false);
  });

  it('keeps legacy HMAC signed payloads readable outside commercial startup validation', function() {
    const payload = {
      customer: 'Example Ltd',
      features: ['time_balance'],
    };
    const secret = 'test-license-secret';

    process.env.NODE_ENV = 'production';
    process.env.TIMEOFF_LICENSE_SECRET = secret;
    process.env.TIMEOFF_LICENSE = JSON.stringify({
      payload,
      signature: features.signLicensePayload(payload, secret),
    });

    expect(features.isEnabled('time_balance')).to.equal(true);
  });

  it('keeps RSA signed TIMEOFF_LICENSE payloads enabled in production-like environments', function() {
    const keyPair = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
    const privateKey = keyPair.privateKey.export({type: 'pkcs1', format: 'pem'});
    const publicKey = keyPair.publicKey.export({type: 'pkcs1', format: 'pem'});
    const payload = {
      customer: 'Example Ltd',
      features: ['time_balance'],
    };

    process.env.NODE_ENV = 'production';
    process.env.TIMEOFF_LICENSE_PUBLIC_KEY = publicKey;
    process.env.TIMEOFF_LICENSE = JSON.stringify({
      payload,
      algorithm: 'RSA-SHA256',
      signature: features.signLicensePayloadWithPrivateKey(payload, privateKey),
    });

    expect(features.isEnabled('time_balance')).to.equal(true);
    expect(features.getLicenseStatus()).to.deep.include({
      valid: true,
      reason: 'valid',
      source: 'env',
      customer: 'Example Ltd',
      expires: null,
    });
    expect(features.getLicenseStatus().features).to.deep.equal(['time_balance']);
  });

  it('rejects RSA signed TIMEOFF_LICENSE payloads without a public key', function() {
    const keyPair = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
    const privateKey = keyPair.privateKey.export({type: 'pkcs1', format: 'pem'});
    const payload = {
      customer: 'Example Ltd',
      features: ['time_balance'],
    };

    process.env.NODE_ENV = 'production';
    process.env.TIMEOFF_LICENSE = JSON.stringify({
      payload,
      algorithm: 'RSA-SHA256',
      signature: features.signLicensePayloadWithPrivateKey(payload, privateKey),
    });

    expect(features.isEnabled('time_balance')).to.equal(false);
    expect(features.getLicenseStatus().reason).to.equal('missing_signature_or_public_key');
  });

  it('keeps signed TIMEOFF_LICENSE payloads with future expiry enabled', function() {
    const payload = {
      customer: 'Example Ltd',
      features: ['time_balance'],
      expires: '2999-12-31T23:59:59.000Z',
    };
    const secret = 'test-license-secret';

    process.env.NODE_ENV = 'production';
    process.env.TIMEOFF_LICENSE_SECRET = secret;
    process.env.TIMEOFF_LICENSE = JSON.stringify({
      payload,
      signature: features.signLicensePayload(payload, secret),
    });

    expect(features.isEnabled('time_balance')).to.equal(true);
    expect(features.getLicenseStatus()).to.deep.include({
      valid: true,
      reason: 'valid',
      source: 'env',
      customer: 'Example Ltd',
      expires: '2999-12-31T23:59:59.000Z',
    });
    expect(features.getLicenseStatus().features).to.deep.equal(['time_balance']);
  });

  it('rejects signed TIMEOFF_LICENSE payloads with past expiry', function() {
    const payload = {
      customer: 'Example Ltd',
      features: ['time_balance'],
      expires: '2000-01-01T00:00:00.000Z',
    };
    const secret = 'test-license-secret';

    process.env.NODE_ENV = 'production';
    process.env.TIMEOFF_LICENSE_SECRET = secret;
    process.env.TIMEOFF_LICENSE = JSON.stringify({
      payload,
      signature: features.signLicensePayload(payload, secret),
    });

    expect(features.isEnabled('time_balance')).to.equal(false);
    expect(features.getLicenseStatus().reason).to.equal('expired');
  });

  it('rejects signed TIMEOFF_LICENSE payloads with malformed expiry', function() {
    const payload = {
      customer: 'Example Ltd',
      features: ['time_balance'],
      expires: 'not-a-date',
    };
    const secret = 'test-license-secret';

    process.env.NODE_ENV = 'production';
    process.env.TIMEOFF_LICENSE_SECRET = secret;
    process.env.TIMEOFF_LICENSE = JSON.stringify({
      payload,
      signature: features.signLicensePayload(payload, secret),
    });

    expect(features.isEnabled('time_balance')).to.equal(false);
    expect(features.getLicenseStatus().reason).to.equal('invalid_expiry');
  });

  it('does not expose raw license or signature in license status', function() {
    const payload = {
      customer: 'Example Ltd',
      features: ['time_balance'],
    };
    const secret = 'test-license-secret';
    const signature = features.signLicensePayload(payload, secret);

    process.env.NODE_ENV = 'production';
    process.env.TIMEOFF_LICENSE_SECRET = secret;
    process.env.TIMEOFF_LICENSE = JSON.stringify({payload, signature});

    const status = features.getLicenseStatus();

    expect(status.customer).to.equal('Example Ltd');
    expect(status.features).to.deep.equal(['time_balance']);
    expect(status.signature).to.equal(undefined);
    expect(status.secret).to.equal(undefined);
    expect(status.raw).to.equal(undefined);
    expect(JSON.stringify(status)).to.not.contain(signature);
    expect(JSON.stringify(status)).to.not.contain(secret);
  });

  it('rejects expired unsigned TIMEOFF_LICENSE payloads in development environments', function() {
    process.env.NODE_ENV = 'test';
    process.env.TIMEOFF_LICENSE = JSON.stringify({
      customer: 'Example Ltd',
      features: ['time_balance'],
      expires: '2000-01-01T00:00:00.000Z',
    });

    expect(features.isEnabled('time_balance')).to.equal(false);
    expect(features.getLicenseStatus().reason).to.equal('expired');
  });

  it('keeps unsigned TIMEOFF_LICENSE payloads enabled in development environments', function() {
    process.env.NODE_ENV = 'test';
    process.env.TIMEOFF_LICENSE = JSON.stringify({
      customer: 'Example Ltd',
      features: ['time_balance'],
      expires: '2999-12-31T23:59:59.000Z',
    });

    expect(features.isEnabled('time_balance')).to.equal(true);
    expect(features.getLicenseStatus().reason).to.equal('valid');
  });

  /*
    Unsigned-license trust root (WR-01 fold, D-20).

    allowUnsignedLicenses() is the OEM gate's trust root: an unsigned
    {"features":["custom_branding"]} payload activates the white-label
    entitlement wherever it returns true. The matrix below pins the
    tightened default - NODE_ENV=test only - with the explicit
    ALLOW_UNSIGNED_LICENSES=true escape hatch preserved for dev boots:

    - development alone no longer grants (pre-fix it did: the old default
      was !productionLikeEnvironment());
    - an unset NODE_ENV (bare `node app.js`, a misconfigured orchestrator)
      no longer grants either;
    - the env escape hatch remains the deliberate dev opt-in.
  */
  describe('unsigned license trust root (WR-01, D-20)', function() {
    const unsignedLicense = () => JSON.stringify({
      customer: 'Example Ltd',
      features: ['time_balance'],
      expires: '2999-12-31T23:59:59.000Z',
    });

    it('accepts unsigned licenses under NODE_ENV=test with no overrides', function() {
      process.env.NODE_ENV = 'test';
      process.env.TIMEOFF_LICENSE = unsignedLicense();

      expect(features.isEnabled('time_balance')).to.equal(true);
      expect(features.getLicenseStatus().reason).to.equal('valid');
    });

    it('rejects unsigned licenses under NODE_ENV=development with no overrides', function() {
      process.env.NODE_ENV = 'development';
      process.env.TIMEOFF_LICENSE = unsignedLicense();

      expect(features.isEnabled('time_balance')).to.equal(false);
      expect(features.getLicenseStatus().reason).to.equal('unsigned_not_allowed');
    });

    it('rejects unsigned licenses when NODE_ENV is unset entirely', function() {
      process.env.TIMEOFF_LICENSE = unsignedLicense();

      expect(features.isEnabled('time_balance')).to.equal(false);
      expect(features.getLicenseStatus().reason).to.equal('unsigned_not_allowed');
    });

    it('accepts unsigned licenses in development only via the ALLOW_UNSIGNED_LICENSES=true escape hatch', function() {
      process.env.NODE_ENV = 'development';
      process.env.ALLOW_UNSIGNED_LICENSES = 'true';
      process.env.TIMEOFF_LICENSE = unsignedLicense();

      expect(features.isEnabled('time_balance')).to.equal(true);
      expect(features.getLicenseStatus().reason).to.equal('valid');
    });

    it('rejects unsigned licenses in production-like environments even with the escape hatch', function() {
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_UNSIGNED_LICENSES = 'true';
      process.env.TIMEOFF_LICENSE = unsignedLicense();

      expect(features.isEnabled('time_balance')).to.equal(false);
      expect(features.getLicenseStatus().reason).to.equal('unsigned_not_allowed');

      process.env.NODE_ENV = 'staging';

      expect(features.isEnabled('time_balance')).to.equal(false);
      expect(features.getLicenseStatus().reason).to.equal('unsigned_not_allowed');
    });

    it('rejects unsigned licenses in the commercial edition even under NODE_ENV=test with the escape hatch', function() {
      process.env.NODE_ENV = 'test';
      process.env.TIMEOFF_EDITION = 'commercial';
      process.env.LEAVEPILOT_EDITION = 'commercial';
      process.env.ALLOW_UNSIGNED_LICENSES = 'true';
      process.env.TIMEOFF_LICENSE = unsignedLicense();

      expect(features.isEnabled('time_balance')).to.equal(false);
      expect(features.getLicenseStatus().reason).to.equal('unsigned_not_allowed');
    });
  });

  it('rejects TIMEOFF_LICENSE payloads with mismatched signatures', function() {
    const signedPayload = {
      customer: 'Example Ltd',
      features: ['time_balance'],
    };
    const tamperedPayload = {
      customer: 'Example Ltd',
      features: ['time_balance', 'vacation_planning'],
    };
    const secret = 'test-license-secret';

    process.env.NODE_ENV = 'production';
    process.env.TIMEOFF_LICENSE_SECRET = secret;
    process.env.TIMEOFF_LICENSE = JSON.stringify({
      payload: tamperedPayload,
      signature: features.signLicensePayload(signedPayload, secret),
    });

    expect(features.isEnabled('time_balance')).to.equal(false);
    expect(features.isEnabled('vacation_planning')).to.equal(false);
  });

  it('rejects RSA TIMEOFF_LICENSE payloads with mismatched signatures', function() {
    const keyPair = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
    const privateKey = keyPair.privateKey.export({type: 'pkcs1', format: 'pem'});
    const publicKey = keyPair.publicKey.export({type: 'pkcs1', format: 'pem'});
    const signedPayload = {
      customer: 'Example Ltd',
      features: ['time_balance'],
    };
    const tamperedPayload = {
      customer: 'Example Ltd',
      features: ['time_balance', 'vacation_planning'],
    };

    process.env.NODE_ENV = 'production';
    process.env.TIMEOFF_LICENSE_PUBLIC_KEY = publicKey;
    process.env.TIMEOFF_LICENSE = JSON.stringify({
      payload: tamperedPayload,
      algorithm: 'RSA-SHA256',
      signature: features.signLicensePayloadWithPrivateKey(signedPayload, privateKey),
    });

    expect(features.isEnabled('time_balance')).to.equal(false);
    expect(features.isEnabled('vacation_planning')).to.equal(false);
  });

  it('rejects TIMEOFF_LICENSE payloads with unsupported signature algorithms', function() {
    const payload = {
      customer: 'Example Ltd',
      features: ['time_balance'],
    };

    process.env.NODE_ENV = 'production';
    process.env.TIMEOFF_LICENSE = JSON.stringify({
      payload,
      algorithm: 'MD5',
      signature: 'not-used',
    });

    expect(features.isEnabled('time_balance')).to.equal(false);
    expect(features.getLicenseStatus().reason).to.equal('unsupported_signature_algorithm');
  });

  it('does not allow environment overrides to bypass production licensing', function() {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_UNLICENSED_FEATURE_OVERRIDES = 'true';
    process.env.FEATURE_TIME_BALANCE = 'true';

    expect(features.isEnabled('time_balance')).to.equal(false);
  });

  it('does not allow unsigned licenses to bypass production licensing', function() {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_UNSIGNED_LICENSES = 'true';
    process.env.TIMEOFF_LICENSE = JSON.stringify({
      features: ['time_balance'],
    });

    expect(features.isEnabled('time_balance')).to.equal(false);
  });

  it('requires RSA license inputs for commercial mode', function() {
    process.env.NODE_ENV = 'production';

    expect(function() {
      features.assertCommercialLicense();
    }).to.throw(/TIMEOFF_LICENSE/);

    process.env.TIMEOFF_LICENSE = '{}';

    expect(function() {
      features.assertCommercialLicense();
    }).to.throw(/TIMEOFF_LICENSE_PUBLIC_KEY/);
  });

  it('accepts a valid RSA license for commercial mode', function() {
    const keyPair = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
    const privateKey = keyPair.privateKey.export({type: 'pkcs1', format: 'pem'});
    const publicKey = keyPair.publicKey.export({type: 'pkcs1', format: 'pem'});
    const payload = {
      customer: 'Example Ltd',
      features: ['time_balance'],
    };

    process.env.NODE_ENV = 'production';
    process.env.TIMEOFF_LICENSE_PUBLIC_KEY = publicKey;
    process.env.TIMEOFF_LICENSE = JSON.stringify({
      payload,
      algorithm: 'RSA-SHA256',
      signature: features.signLicensePayloadWithPrivateKey(payload, privateKey),
    });

    expect(features.assertCommercialLicense().valid).to.equal(true);
  });

  it('lets explicit false overrides disable licensed features', function() {
    process.env.NODE_ENV = 'production';
    process.env.FEATURE_TIME_BALANCE = 'false';
    config.set('licensed_features', ['time_balance']);

    expect(features.isEnabled('time_balance')).to.equal(false);
  });

  it('returns a JSON 403 response for disabled API features', function() {
    const middleware = features.requireFeature('time_balance');
    const req = {
      originalUrl: '/api/v1/time-balance/',
      accepts(types) {
        return types.indexOf('json') === -1 ? false : 'json';
      },
      t(key) {
        return key;
      },
    };
    const res = {
      statusCode: 200,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        return this;
      },
    };

    middleware(req, res, function() {
      throw new Error('Middleware should not continue for disabled features');
    });

    expect(res.statusCode).to.equal(403);
    expect(res.payload).to.deep.equal({
      error: 'feature_disabled',
      feature: 'time_balance',
      message: 'features.messages.disabled',
    });
  });

  describe('License schema v2 and grace period', function() {
    function rsaEnvFor(payload) {
      const keyPair = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
      const privateKey = keyPair.privateKey.export({type: 'pkcs1', format: 'pem'});
      const publicKey = keyPair.publicKey.export({type: 'pkcs1', format: 'pem'});

      process.env.NODE_ENV = 'production';
      process.env.TIMEOFF_LICENSE_PUBLIC_KEY = publicKey;
      process.env.TIMEOFF_LICENSE = JSON.stringify({
        payload,
        algorithm: 'RSA-SHA256',
        signature: features.signLicensePayloadWithPrivateKey(payload, privateKey),
      });

      return {privateKey, publicKey};
    }

    function isoDaysFromNow(days) {
      return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }

    it('accepts a valid v2 payload and exposes its metadata in status', function() {
      rsaEnvFor({
        schemaVersion: 2,
        licenseId: 'lic-001',
        customerId: 'cust-42',
        customerName: 'Example Ltd',
        plan: 'enterprise',
        features: ['time_balance'],
        issuedAt: isoDaysFromNow(-1),
        expiresAt: isoDaysFromNow(365),
        maintenanceUntil: isoDaysFromNow(365),
        maxActiveUsers: 150,
      });

      const status = features.getLicenseStatus();
      expect(status.valid).to.equal(true);
      expect(status.schemaVersion).to.equal(2);
      expect(status.licenseId).to.equal('lic-001');
      expect(status.customer).to.equal('Example Ltd');
      expect(status.customerId).to.equal('cust-42');
      expect(status.plan).to.equal('enterprise');
      expect(status.maxActiveUsers).to.equal(150);
      expect(status.daysUntilExpiry).to.be.within(364, 366);
      expect(features.isEnabled('time_balance')).to.equal(true);
    });

    it('rejects v2 payloads without licenseId', function() {
      rsaEnvFor({
        schemaVersion: 2,
        customerName: 'Example Ltd',
        features: ['time_balance'],
      });

      expect(features.getLicenseStatus().reason).to.equal('missing_license_id');
      expect(features.isEnabled('time_balance')).to.equal(false);
    });

    it('rejects licenses that are not yet valid (notBefore in future)', function() {
      rsaEnvFor({
        schemaVersion: 2,
        licenseId: 'lic-nb',
        customerName: 'Example Ltd',
        features: ['time_balance'],
        issuedAt: isoDaysFromNow(-1),
        notBefore: isoDaysFromNow(5),
      });

      expect(features.getLicenseStatus().reason).to.equal('not_yet_valid');
      expect(features.isEnabled('time_balance')).to.equal(false);
    });

    it('rejects licenses for a different core major version', function() {
      rsaEnvFor({
        schemaVersion: 2,
        licenseId: 'lic-major',
        customerName: 'Example Ltd',
        features: ['time_balance'],
        issuedAt: isoDaysFromNow(-1),
        allowedMajorVersions: [1],
      });

      expect(features.getLicenseStatus().reason).to.equal('unsupported_major_version');
      expect(features.isEnabled('time_balance')).to.equal(false);
    });

    it('keeps features enabled during the post-expiry grace period', function() {
      rsaEnvFor({
        schemaVersion: 2,
        licenseId: 'lic-grace',
        customerName: 'Example Ltd',
        features: ['time_balance'],
        issuedAt: isoDaysFromNow(-30),
        expiresAt: isoDaysFromNow(-3),
      });

      const status = features.getLicenseStatus();
      expect(status.valid).to.equal(true);
      expect(status.inGrace).to.equal(true);
      expect(status.reason).to.equal('expired_in_grace');
      expect(features.isEnabled('time_balance')).to.equal(true);
    });

    it('disables features after the grace period without blocking startup', function() {
      rsaEnvFor({
        schemaVersion: 2,
        licenseId: 'lic-dead',
        customerName: 'Example Ltd',
        features: ['time_balance'],
        issuedAt: isoDaysFromNow(-60),
        expiresAt: isoDaysFromNow(-30),
      });

      expect(features.getLicenseStatus().reason).to.equal('expired');
      expect(features.isEnabled('time_balance')).to.equal(false);

      // assertCommercialLicense must not throw for pure expiry
      const originalError = console.error;
      console.error = function() {};
      try {
        const status = features.assertCommercialLicense();
        expect(status.valid).to.equal(false);
        expect(status.reason).to.equal('expired');
      } finally {
        console.error = originalError;
      }
    });

    it('honours TIMEOFF_LICENSE_GRACE_DAYS override', function() {
      process.env.TIMEOFF_LICENSE_GRACE_DAYS = '0';

      rsaEnvFor({
        schemaVersion: 2,
        licenseId: 'lic-nograce',
        customerName: 'Example Ltd',
        features: ['time_balance'],
        issuedAt: isoDaysFromNow(-30),
        expiresAt: isoDaysFromNow(-1),
      });

      expect(features.getLicenseStatus().reason).to.equal('expired');
      expect(features.isEnabled('time_balance')).to.equal(false);
    });

    it('selects the public key from the key ring by keyId', function() {
      const oldPair = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
      const newPair = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
      const payload = {
        schemaVersion: 2,
        licenseId: 'lic-ring',
        customerName: 'Example Ltd',
        features: ['time_balance'],
        issuedAt: isoDaysFromNow(-1),
        keyId: 'k2',
      };

      process.env.NODE_ENV = 'production';
      // Primary env key is the OLD key; ring provides the NEW one under k2.
      process.env.TIMEOFF_LICENSE_PUBLIC_KEY = oldPair.publicKey.export({type: 'pkcs1', format: 'pem'});
      process.env.TIMEOFF_LICENSE_PUBLIC_KEYS = JSON.stringify({
        k2: newPair.publicKey.export({type: 'pkcs1', format: 'pem'}),
      });
      process.env.TIMEOFF_LICENSE = JSON.stringify({
        payload,
        algorithm: 'RSA-SHA256',
        signature: features.signLicensePayloadWithPrivateKey(
          payload,
          newPair.privateKey.export({type: 'pkcs1', format: 'pem'})
        ),
      });

      const status = features.getLicenseStatus();
      expect(status.valid).to.equal(true);
      expect(status.keyId).to.equal('k2');
      expect(features.isEnabled('time_balance')).to.equal(true);
    });

    it('keeps v1 payloads working unchanged (backward compatibility)', function() {
      rsaEnvFor({
        customer: 'Legacy Ltd',
        features: ['time_balance'],
        expires: isoDaysFromNow(100),
      });

      const status = features.getLicenseStatus();
      expect(status.valid).to.equal(true);
      expect(status.schemaVersion).to.equal(1);
      expect(status.customer).to.equal('Legacy Ltd');
      expect(features.isEnabled('time_balance')).to.equal(true);
    });

    it('disables a license listed in a valid signed revocation list', function() {
      const pair = rsaEnvFor({
        schemaVersion: 2,
        licenseId: 'lic-revoked',
        customerName: 'Example Ltd',
        features: ['time_balance'],
        issuedAt: isoDaysFromNow(-2),
        expiresAt: isoDaysFromNow(100),
      });
      const crlPayload = {
        schemaVersion: 1,
        issuedAt: isoDaysFromNow(-1),
        expiresAt: isoDaysFromNow(30),
        revokedLicenseIds: ['lic-revoked'],
      };

      process.env.TIMEOFF_LICENSE_REVOCATION_PUBLIC_KEY = pair.publicKey;
      process.env.TIMEOFF_LICENSE_REVOCATION_LIST = JSON.stringify({
        payload: crlPayload,
        algorithm: 'RSA-SHA256',
        signature: features.signLicensePayloadWithPrivateKey(crlPayload, pair.privateKey),
      });

      expect(features.getLicenseStatus().reason).to.equal('revoked');
      expect(features.isEnabled('time_balance')).to.equal(false);
    });

    it('keeps an unlisted license enabled with a valid signed revocation list', function() {
      const pair = rsaEnvFor({
        schemaVersion: 2,
        licenseId: 'lic-active',
        customerName: 'Example Ltd',
        features: ['time_balance'],
        issuedAt: isoDaysFromNow(-2),
        expiresAt: isoDaysFromNow(100),
      });
      const crlPayload = {
        schemaVersion: 1,
        issuedAt: isoDaysFromNow(-1),
        expiresAt: isoDaysFromNow(30),
        revokedLicenseIds: ['lic-other'],
      };

      process.env.TIMEOFF_LICENSE_REVOCATION_PUBLIC_KEY = pair.publicKey;
      process.env.TIMEOFF_LICENSE_REVOCATION_LIST = JSON.stringify({
        payload: crlPayload,
        algorithm: 'RSA-SHA256',
        signature: features.signLicensePayloadWithPrivateKey(crlPayload, pair.privateKey),
      });

      const status = features.getLicenseStatus();
      expect(status.valid).to.equal(true);
      expect(status.revocationListExpiresAt).to.equal(crlPayload.expiresAt);
      expect(features.isEnabled('time_balance')).to.equal(true);
    });
  });
});
