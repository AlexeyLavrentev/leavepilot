'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const envResolver = require('./env_resolver');
const {isCommercialEdition} = require('./edition/commercial_mode');

const FEATURE_CATALOG = {
  ldap_authentication: { defaultEnabled: true },
  sso_authentication: { defaultEnabled: false },
  integration_api: { defaultEnabled: false },
  employee_groups: { defaultEnabled: false },
  work_calendars: { defaultEnabled: false },
  leave_start_reminders: { defaultEnabled: true },
};

const PLAN_PRESETS_PATH = path.join(__dirname, '..', 'config', 'plan_presets.json');

let PLAN_PRESETS = {};

try {
  PLAN_PRESETS = JSON.parse(fs.readFileSync(PLAN_PRESETS_PATH, 'utf8'));
} catch (error) {
  PLAN_PRESETS = {};
}

const normalizeFeatureName = name => String(name || '').trim().toLowerCase();

const resolvePlan = planName => {
  const normalized = String(planName || '').trim().toLowerCase();
  return PLAN_PRESETS[normalized] || null;
};

const PRODUCTION_LIKE_ENVIRONMENTS = ['production', 'staging'];

const parseList = value => {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map(normalizeFeatureName).filter(Boolean);
  }

  return String(value)
    .split(',')
    .map(normalizeFeatureName)
    .filter(Boolean);
};

const parseBoolean = value => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return ['true', '1', 'yes', 'on'].indexOf(value.toLowerCase()) !== -1;
  }

  return !!value;
};

const registerFeature = (name, options) => {
  const normalizedName = normalizeFeatureName(name);

  if (!normalizedName) {
    throw new Error('Feature name is required');
  }

  FEATURE_CATALOG[normalizedName] = {
    defaultEnabled: !!(options && options.defaultEnabled),
  };
};

const productionLikeEnvironment = () =>
  PRODUCTION_LIKE_ENVIRONMENTS.indexOf(process.env.NODE_ENV) !== -1;

const canonicalize = value => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonicalize(value[key]);
      return acc;
    }, {});
  }

  return value;
};

const canonicalJson = value => JSON.stringify(canonicalize(value));

const getLicenseSecret = () =>
  envResolver.resolve('LICENSE_SECRET') || config.get('license_secret') || '';

const getLicensePublicKey = () =>
  envResolver.resolve('LICENSE_PUBLIC_KEY') || config.get('license_public_key') || '';

// Optional key ring for rotation: TIMEOFF_LICENSE_PUBLIC_KEYS is a JSON map
// of keyId -> PEM. A v2 license carrying keyId selects its key from the
// ring; anything else falls back to the single TIMEOFF_LICENSE_PUBLIC_KEY.
const getLicensePublicKeyRing = () => {
  const raw = envResolver.resolve('LICENSE_PUBLIC_KEYS')
    || config.get('license_public_keys')
    || '';

  if (!raw) {
    return {};
  }

  try {
    const parsed = typeof raw === 'object' ? raw : JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
};

const getLicensePublicKeyForPayload = payload => {
  const keyId = payload && payload.keyId;

  if (keyId) {
    const ringKey = getLicensePublicKeyRing()[keyId];
    return ringKey || '';
  }

  return getLicensePublicKey();
};

const normalizePem = value => String(value || '').replace(/\\n/g, '\n');

const signLicensePayload = (payload, secret) =>
  crypto
    .createHmac('sha256', secret)
    .update(canonicalJson(payload))
    .digest('hex');

const signLicensePayloadWithPrivateKey = (payload, privateKey) =>
  crypto
    .sign('RSA-SHA256', Buffer.from(canonicalJson(payload)), normalizePem(privateKey))
    .toString('base64');

const signaturesMatch = (expected, actual) => {
  const expectedBuffer = Buffer.from(String(expected || ''), 'hex');
  const actualBuffer = Buffer.from(String(actual || ''), 'hex');

  if (!expectedBuffer.length || expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
};

const verifyPublicKeySignature = (payload, signature, publicKey) => {
  try {
    return crypto.verify(
      'RSA-SHA256',
      Buffer.from(canonicalJson(payload)),
      normalizePem(publicKey),
      Buffer.from(String(signature || ''), 'base64')
    );
  } catch (error) {
    return false;
  }
};

const getRevocationPublicKey = () =>
  envResolver.resolve('LICENSE_REVOCATION_PUBLIC_KEY')
  || config.get('license_revocation_public_key')
  || getLicensePublicKey();

const revocationListRawValue = () =>
  envResolver.resolve('LICENSE_REVOCATION_LIST')
  || config.get('license_revocation_list')
  || null;

const verifyRevocationListForLicense = licenseResult => {
  const raw = revocationListRawValue();
  if (!raw || !licenseResult.valid || !licenseResult.payload.licenseId) {
    return licenseResult;
  }

  const parsed = parseLicense(raw);
  const envelope = parsed.parsed || {};
  const payload = envelope.payload || {};
  const publicKey = getRevocationPublicKey();

  if (parsed.reason !== 'parsed'
      || String(envelope.algorithm || '').toUpperCase() !== 'RSA-SHA256'
      || !envelope.signature
      || !publicKey
      || !verifyPublicKeySignature(payload, envelope.signature, publicKey)) {
    return Object.assign({}, licenseResult, {
      valid: false,
      reason: 'invalid_revocation_list',
    });
  }

  if (Number(payload.schemaVersion) !== 1
      || !isValidIsoDate(payload.issuedAt)
      || !isValidIsoDate(payload.expiresAt)
      || !Array.isArray(payload.revokedLicenseIds)
      || payload.revokedLicenseIds.some(id => !isNonEmptyString(id))) {
    return Object.assign({}, licenseResult, {
      valid: false,
      reason: 'invalid_revocation_list_payload',
    });
  }

  if (Date.parse(payload.issuedAt) > Date.now()) {
    return Object.assign({}, licenseResult, {
      valid: false,
      reason: 'revocation_list_not_yet_valid',
    });
  }

  if (Date.parse(payload.expiresAt) < Date.now()) {
    return Object.assign({}, licenseResult, {
      valid: false,
      reason: 'revocation_list_expired',
    });
  }

  if (payload.revokedLicenseIds.includes(licenseResult.payload.licenseId)) {
    return Object.assign({}, licenseResult, {
      valid: false,
      reason: 'revoked',
      revokedAt: payload.issuedAt,
    });
  }

  return Object.assign({}, licenseResult, {
    revocationListIssuedAt: payload.issuedAt,
    revocationListExpiresAt: payload.expiresAt,
  });
};

const parseLicense = raw => {
  if (!raw) {
    return {
      parsed: {},
      reason: 'missing',
    };
  }

  if (typeof raw === 'object') {
    return {
      parsed: raw,
      reason: 'parsed',
    };
  }

  try {
    return {
      parsed: JSON.parse(raw),
      reason: 'parsed',
    };
  } catch (jsonError) {
    try {
      return {
        parsed: JSON.parse(Buffer.from(raw, 'base64').toString('utf8')),
        reason: 'parsed',
      };
    } catch (base64Error) {
      return {
        parsed: {},
        reason: 'invalid_format',
      };
    }
  }
};

const allowUnsignedLicenses = () => {
  if (productionLikeEnvironment() || isCommercialEdition()) {
    return false;
  }

  if (typeof process.env.ALLOW_UNSIGNED_LICENSES !== 'undefined') {
    return parseBoolean(process.env.ALLOW_UNSIGNED_LICENSES);
  }

  const configuredValue = config.get('allow_unsigned_licenses');

  if (typeof configuredValue !== 'undefined') {
    return parseBoolean(configuredValue);
  }

  return !productionLikeEnvironment();
};

const licenseRawValue = () => {
  if (envResolver.resolve('LICENSE')) {
    return {
      raw: envResolver.resolve('LICENSE'),
      source: 'env',
    };
  }

  const configuredLicense = config.get('license');

  if (configuredLicense) {
    return {
      raw: configuredLicense,
      source: 'config',
    };
  }

  return {
    raw: null,
    source: 'none',
  };
};

const DEFAULT_LICENSE_GRACE_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const getLicenseGraceDays = () => {
  const configured = Number(
    envResolver.resolve('LICENSE_GRACE_DAYS')
    || config.get('license_grace_days')
  );

  // Deployment operators may shorten the vendor grace period, but cannot
  // extend a commercial entitlement by changing an environment variable.
  return Number.isFinite(configured) && configured >= 0
    ? Math.min(configured, DEFAULT_LICENSE_GRACE_DAYS)
    : DEFAULT_LICENSE_GRACE_DAYS;
};

const getCoreMajorVersion = () => {
  try {
    const version = require('../package.json').version || '';
    return Number(String(version).split('.')[0]);
  } catch (error) {
    return null;
  }
};

// Schema v2 uses expiresAt; v1 used expires. Both are accepted.
const getLicenseExpiryRaw = payload =>
  payload.expiresAt || payload.expires || null;

const getLicenseSchemaVersion = payload => {
  const version = Number(payload.schemaVersion);
  return Number.isFinite(version) && version > 0 ? version : 1;
};

const isNonEmptyString = value =>
  typeof value === 'string' && value.trim().length > 0;

const isValidIsoDate = value =>
  isNonEmptyString(value) && !Number.isNaN(Date.parse(value));

const validateV2LicensePayload = payload => {
  if (Number(payload.schemaVersion) !== 2) return 'unsupported_schema_version';
  if (!isNonEmptyString(payload.licenseId)) return 'missing_license_id';
  if (!isNonEmptyString(payload.customerName)) return 'missing_customer_name';
  if (!isValidIsoDate(payload.issuedAt)) return 'invalid_issued_at';
  if (!Array.isArray(payload.features)
      || payload.features.some(feature => !isNonEmptyString(feature))) {
    return 'invalid_features';
  }
  if (payload.customerId !== undefined && !isNonEmptyString(payload.customerId)) {
    return 'invalid_customer_id';
  }
  if (payload.keyId !== undefined && !isNonEmptyString(payload.keyId)) {
    return 'invalid_key_id';
  }
  if (payload.maxActiveUsers !== undefined
      && (!Number.isSafeInteger(payload.maxActiveUsers) || payload.maxActiveUsers < 1)) {
    return 'invalid_max_active_users';
  }
  if (payload.allowedMajorVersions !== undefined
      && (!Array.isArray(payload.allowedMajorVersions)
        || !payload.allowedMajorVersions.length
        || payload.allowedMajorVersions.some(version =>
          !Number.isSafeInteger(version) || version < 1))) {
    return 'invalid_allowed_major_versions';
  }

  for (const field of ['notBefore', 'expiresAt', 'maintenanceUntil']) {
    if (payload[field] !== undefined && !isValidIsoDate(payload[field])) {
      return 'invalid_' + field.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
    }
  }

  return null;
};

const validateLicensePayload = payload => {
  if (!payload || typeof payload !== 'object') {
    return {
      valid: false,
      reason: 'invalid_payload',
      payload: {},
    };
  }

  const schemaVersion = getLicenseSchemaVersion(payload);

  if (schemaVersion >= 2) {
    const validationReason = validateV2LicensePayload(payload);

    if (validationReason) {
      return {
        valid: false,
        reason: validationReason,
        payload,
      };
    }
  }

  if (schemaVersion < 1) {
    return {
      valid: false,
      reason: 'unsupported_schema_version',
      payload,
    };
  }

  if (payload.notBefore) {
    const notBefore = Date.parse(payload.notBefore);

    if (Number.isNaN(notBefore)) {
      return {
        valid: false,
        reason: 'invalid_not_before',
        payload,
      };
    }

    if (notBefore > Date.now()) {
      return {
        valid: false,
        reason: 'not_yet_valid',
        payload,
      };
    }
  }

  if (Array.isArray(payload.allowedMajorVersions) && payload.allowedMajorVersions.length) {
    const coreMajor = getCoreMajorVersion();
    const allowed = payload.allowedMajorVersions.map(Number);

    if (coreMajor !== null && allowed.indexOf(coreMajor) === -1) {
      return {
        valid: false,
        reason: 'unsupported_major_version',
        payload,
      };
    }
  }

  const expiryRaw = getLicenseExpiryRaw(payload);

  if (expiryRaw) {
    const expiresAt = Date.parse(expiryRaw);

    if (Number.isNaN(expiresAt)) {
      return {
        valid: false,
        reason: 'invalid_expiry',
        payload,
      };
    }

    if (expiresAt < Date.now()) {
      // Expiry is a commercial condition, not a tamper signal: give the
      // customer a grace window to renew before premium features go dark.
      // Community functionality and data access are never blocked.
      const graceEndsAt = expiresAt + getLicenseGraceDays() * MS_PER_DAY;

      if (graceEndsAt >= Date.now()) {
        return {
          valid: true,
          reason: 'expired_in_grace',
          inGrace: true,
          graceEndsAt: new Date(graceEndsAt).toISOString(),
          payload,
        };
      }

      return {
        valid: false,
        reason: 'expired',
        payload,
      };
    }
  }

  return {
    valid: true,
    reason: 'valid',
    payload,
  };
};

const verifyLicenseEnvelope = (license, source) => {
  if (!license || typeof license !== 'object') {
    return {
      valid: false,
      reason: 'missing',
      source,
      payload: {},
    };
  }

  if (!license.payload && !license.signature) {
    if (!allowUnsignedLicenses()) {
      return {
        valid: false,
        reason: 'unsigned_not_allowed',
        source,
        payload: {},
      };
    }

    return Object.assign(validateLicensePayload(license), { source });
  }

  const payload = license.payload;
  const signature = license.signature;
  const algorithm = String(license.algorithm || 'HMAC-SHA256').toUpperCase();

  if (algorithm === 'RSA-SHA256') {
    const publicKey = getLicensePublicKeyForPayload(payload);

    if (payload && payload.keyId && !publicKey) {
      return {
        valid: false,
        reason: 'unknown_key_id',
        source,
        payload,
      };
    }

    if (!payload || !signature || !publicKey) {
      return {
        valid: false,
        reason: 'missing_signature_or_public_key',
        source,
        payload: payload || {},
      };
    }

    if (!verifyPublicKeySignature(payload, signature, publicKey)) {
      return {
        valid: false,
        reason: 'invalid_signature',
        source,
        payload: {},
      };
    }

    return Object.assign(validateLicensePayload(payload), { source });
  }

  if (algorithm !== 'HMAC-SHA256') {
    return {
      valid: false,
      reason: 'unsupported_signature_algorithm',
      source,
      payload: {},
    };
  }

  const secret = getLicenseSecret();

  if (!payload || !signature || !secret) {
    return {
      valid: false,
      reason: 'missing_signature_or_secret',
      source,
      payload: payload || {},
    };
  }

  const expectedSignature = signLicensePayload(payload, secret);

  if (!signaturesMatch(expectedSignature, signature)) {
    return {
      valid: false,
      reason: 'invalid_signature',
      source,
      payload: {},
    };
  }

  return Object.assign(validateLicensePayload(payload), { source });
};

const readLicenseResult = () => {
  const licenseValue = licenseRawValue();
  const parsedLicense = parseLicense(licenseValue.raw);

  if (parsedLicense.reason === 'missing') {
    return {
      valid: false,
      reason: 'missing',
      source: licenseValue.source,
      payload: {},
    };
  }

  if (parsedLicense.reason === 'invalid_format') {
    return {
      valid: false,
      reason: 'invalid_format',
      source: licenseValue.source,
      payload: {},
    };
  }

  return verifyRevocationListForLicense(
    verifyLicenseEnvelope(parsedLicense.parsed, licenseValue.source)
  );
};

const readLicensePayload = () => {
  const result = readLicenseResult();

  return result.valid ? result.payload : {};
};

const getLicenseStatus = () => {
  const result = readLicenseResult();
  const payload = result.payload || {};
  const expiryRaw = getLicenseExpiryRaw(payload);
  const expiresAtMs = expiryRaw ? Date.parse(expiryRaw) : NaN;
  const daysUntilExpiry = Number.isNaN(expiresAtMs)
    ? null
    : Math.ceil((expiresAtMs - Date.now()) / MS_PER_DAY);

  return {
    valid: !!result.valid,
    reason: result.reason,
    source: result.source,
    schemaVersion: getLicenseSchemaVersion(payload),
    licenseId: payload.licenseId || null,
    customer: payload.customerName || payload.customer || null,
    customerId: payload.customerId || null,
    plan: payload.plan || null,
    features: parseList(payload.features),
    expires: expiryRaw,
    daysUntilExpiry,
    inGrace: !!result.inGrace,
    graceEndsAt: result.graceEndsAt || null,
    maintenanceUntil: payload.maintenanceUntil || null,
    maxActiveUsers: payload.maxActiveUsers || null,
    keyId: payload.keyId || null,
    revokedAt: result.revokedAt || null,
    revocationListIssuedAt: result.revocationListIssuedAt || null,
    revocationListExpiresAt: result.revocationListExpiresAt || null,
  };
};

const assertCommercialLicense = () => {
  if (!envResolver.resolve('LICENSE')) {
    throw new Error('Commercial mode requires TIMEOFF_LICENSE.');
  }

  if (!envResolver.resolve('LICENSE_PUBLIC_KEY') && !envResolver.resolve('LICENSE_PUBLIC_KEYS')) {
    throw new Error('Commercial mode requires TIMEOFF_LICENSE_PUBLIC_KEY or TIMEOFF_LICENSE_PUBLIC_KEYS.');
  }

  const parsedLicense = parseLicense(envResolver.resolve('LICENSE'));
  const license = parsedLicense.parsed || {};
  const algorithm = String(license.algorithm || '').toUpperCase();

  if (parsedLicense.reason !== 'parsed' || algorithm !== 'RSA-SHA256') {
    throw new Error('Commercial mode requires an RSA-SHA256 signed TIMEOFF_LICENSE.');
  }

  const status = getLicenseStatus();

  if (!status.valid) {
    // Expiry past the grace window is a commercial condition, not tampering:
    // do not block startup. Licensed features stay off (the license payload
    // is no longer readable), Community functionality and data access keep
    // working, and the operator sees a prominent warning instead of an outage.
    if (status.reason === 'expired' || status.reason === 'revoked') {
      console.error(
        'WARNING: commercial license is ' + status.reason + '. '
        + 'Premium features are disabled until a renewed license is installed. '
        + 'Community functionality and data access continue to work.'
      );
      return status;
    }

    throw new Error('Commercial license is invalid: ' + status.reason + '.');
  }

  if (status.inGrace) {
    console.error(
      'WARNING: commercial license expired on ' + status.expires
      + '. Grace period ends at ' + status.graceEndsAt
      + '; premium features will be disabled after that. Renew the license.'
    );
  } else if (status.daysUntilExpiry !== null && status.daysUntilExpiry <= 60) {
    console.warn(
      'Commercial license expires in ' + status.daysUntilExpiry
      + ' day(s) (' + status.expires + '). Plan the renewal.'
    );
  }

  return status;
};

const allowUnlicensedFeatureOverrides = () => {
  if (productionLikeEnvironment() || isCommercialEdition()) {
    return false;
  }

  if (typeof process.env.ALLOW_UNLICENSED_FEATURE_OVERRIDES !== 'undefined') {
    return parseBoolean(process.env.ALLOW_UNLICENSED_FEATURE_OVERRIDES);
  }

  const configuredValue = config.get('allow_unlicensed_feature_overrides');

  if (typeof configuredValue !== 'undefined') {
    return parseBoolean(configuredValue);
  }

  return !productionLikeEnvironment();
};

const allowConfigLicensedFeatures = () => {
  if (productionLikeEnvironment() || isCommercialEdition()) {
    return false;
  }

  if (typeof process.env.ALLOW_CONFIG_LICENSED_FEATURES !== 'undefined') {
    return parseBoolean(process.env.ALLOW_CONFIG_LICENSED_FEATURES);
  }

  const configuredValue = config.get('allow_config_licensed_features');

  if (typeof configuredValue !== 'undefined') {
    return parseBoolean(configuredValue);
  }

  return !productionLikeEnvironment();
};

const getExplicitFeatureOverrides = () => {
  const overrides = {};
  const configuredFeatures = config.get('features') || {};

  Object.keys(configuredFeatures).forEach(name => {
    overrides[normalizeFeatureName(name)] = parseBoolean(configuredFeatures[name]);
  });

  Object.keys(FEATURE_CATALOG).forEach(name => {
    const envKey = 'FEATURE_' + name.toUpperCase();

    if (typeof process.env[envKey] !== 'undefined') {
      overrides[name] = parseBoolean(process.env[envKey]);
    }
  });

  return overrides;
};

const getRequestedFeatureSet = () => {
  const values = parseList(envResolver.resolve('FEATURES'));

  if (values.indexOf('all') !== -1) {
    return new Set(Object.keys(FEATURE_CATALOG));
  }

  return new Set(values.filter(name => FEATURE_CATALOG[name]));
};

const getLicensedFeatureSet = () => {
  const payload = readLicensePayload();
  const configuredFeatures = allowConfigLicensedFeatures()
    ? parseList(config.get('licensed_features'))
    : [];
  const licensedFeatures = parseList(payload.features);
  const values = configuredFeatures.concat(licensedFeatures);

  if (values.indexOf('all') !== -1) {
    return new Set(Object.keys(FEATURE_CATALOG));
  }

  return new Set(values.filter(name => FEATURE_CATALOG[name]));
};

const isEnabled = featureName => {
  const name = normalizeFeatureName(featureName);
  const feature = FEATURE_CATALOG[name];

  if (!feature) {
    return false;
  }

  const overrides = getExplicitFeatureOverrides();

  if (Object.prototype.hasOwnProperty.call(overrides, name) && overrides[name] === false) {
    return false;
  }

  const licensedFeatures = getLicensedFeatureSet();

  if (licensedFeatures.has(name)) {
    return true;
  }

  if (Object.prototype.hasOwnProperty.call(overrides, name)) {
    return overrides[name] && allowUnlicensedFeatureOverrides();
  }

  if (getRequestedFeatureSet().has(name)) {
    return allowUnlicensedFeatureOverrides();
  }

  return feature.defaultEnabled;
};

const getEnabledMap = () => Object.keys(FEATURE_CATALOG).reduce((acc, name) => {
  acc[name] = isEnabled(name);
  return acc;
}, {});

const wantsJsonResponse = req =>
  req.xhr
  || (req.accepts && req.accepts(['html', 'json']) === 'json')
  || /^\/(api|integration)\//.test(req.originalUrl || req.url || '');

const requireFeature = featureName => (req, res, next) => {
  if (isEnabled(featureName)) {
    return next();
  }

  if (wantsJsonResponse(req)) {
    return res.status(403).json({
      error: 'feature_disabled',
      feature: normalizeFeatureName(featureName),
      message: req.t ? req.t('features.messages.disabled') : 'Feature is disabled',
    });
  }

  if (req.session && req.session.flash_error && req.t) {
    req.session.flash_error(req.t('features.messages.disabled'));
  }

  return res.redirect_with_session ? res.redirect_with_session('/') : res.redirect('/');
};

module.exports = {
  catalog: FEATURE_CATALOG,
  planPresets: PLAN_PRESETS,
  resolvePlan,
  isEnabled,
  getEnabledMap,
  requireFeature,
  registerFeature,
  allowUnlicensedFeatureOverrides,
  assertCommercialLicense,
  getLicenseStatus,
  signLicensePayload,
  signLicensePayloadWithPrivateKey,
  parseLicense,
  verifyLicenseEnvelope,
  normalizePem,
  getLicensePublicKey,
};
