'use strict';

const config = require('./config');
const envResolver = require('./env_resolver');
const features = require('./features');

const DEFAULT_BRANDING = {
  name: 'LeavePilot',
  shortName: 'LeavePilot',
  applicationDomain: 'http://app.timeoff.management',
  promotionWebsiteDomain: 'http://timeoff.management',
  logoUrl: '',
  faviconUrl: '/favicon.ico',
  faviconPng32Url: '/favicon-32x32.png',
  faviconPng16Url: '/favicon-16x16.png',
  appIconUrl: '/icon-vacation.png',
  appleTouchIconUrl: '/apple-touch-icon.png',
  manifestUrl: '/manifest.webmanifest',
  senderEmail: 'email@test.com',
  senderName: '',
};

const firstValue = values => {
  for (let index = 0; index < values.length; index += 1) {
    if (typeof values[index] !== 'undefined' && values[index] !== null && values[index] !== '') {
      return values[index];
    }
  }

  return undefined;
};

const formatEmailAddress = ({name, email}) => {
  if (!name) {
    return email;
  }

  const escapedName = String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  return '"' + escapedName + '" <' + email + '>';
};

// D-05 single license-aware gate. branding.get() is consumed by every rendered
// surface (views, email, iCal, manifest, the Phase 3 license line), so making
// it license-aware here is the one change that propagates OEM fallback +
// suppression everywhere.
//
// The entitlement DECISION is memoized for the process lifetime (license
// material — LEAVEPILOT_LICENSE + public key — is boot-time config). Brand DATA
// below stays live (Phase 2 contract, Pitfall 2): branding.get() is called per
// request AND repeatedly per render via the {{brand_name}} helper, so an
// uncached RSA-SHA256 verify on every call would be a real cost.
let _oemCache = null;

const getOemEntitlement = () => {
  if (_oemCache) {
    return _oemCache;
  }

  let active = false;

  try {
    // Read features.getLicenseStatus() DIRECTLY. This MUST NOT route OEM
    // through the feature-enabled helper: grace sets valid:true + inGrace:true
    // (features.js L477-484) and readLicensePayload keeps handing out features
    // through the grace window, so that helper would leak OEM for 14 days after
    // expiry (D-03, the GRACE TRAP). The explicit !status.inGrace term closes
    // that gap.
    const status = features.getLicenseStatus();
    active = !!status.valid
      && !status.inGrace
      && Array.isArray(status.features)
      && status.features.indexOf('custom_branding') !== -1;
  } catch (_error) {
    // OEM-02: the gate NEVER throws to the caller. Any license-verification
    // failure (missing / damaged / expired) resolves to the default brand.
    active = false;
  }

  _oemCache = {active};
  return _oemCache;
};

const get = () => {
  const oem = getOemEntitlement();

  // D-04: without the custom_branding entitlement the operator's BRAND_* env
  // and config/app.json branding section are IGNORED — DEFAULT_BRANDING is the
  // only source. The license grants the RIGHT to ship a custom brand; it does
  // not change the community-edition default. (OEM-02: never throws.)
  if (!oem.active) {
    return Object.assign({}, DEFAULT_BRANDING, {
      emailFrom: formatEmailAddress({
        name: DEFAULT_BRANDING.senderName,
        email: DEFAULT_BRANDING.senderEmail,
      }),
      oemActive: false,
    });
  }

  const configuredBranding = config.get('branding') || {};

  const branding = {
    name: firstValue([envResolver.getEnv('BRAND_NAME'), configuredBranding.name, DEFAULT_BRANDING.name]),
    shortName: firstValue([envResolver.getEnv('BRAND_SHORT_NAME'), configuredBranding.shortName, configuredBranding.short_name, DEFAULT_BRANDING.shortName]),
    applicationDomain: firstValue([envResolver.getEnv('APPLICATION_DOMAIN'), configuredBranding.applicationDomain, configuredBranding.application_domain, config.get('application_domain'), DEFAULT_BRANDING.applicationDomain]),
    promotionWebsiteDomain: firstValue([envResolver.getEnv('PROMOTION_WEBSITE_DOMAIN'), configuredBranding.promotionWebsiteDomain, configuredBranding.promotion_website_domain, config.get('promotion_website_domain'), DEFAULT_BRANDING.promotionWebsiteDomain]),
    logoUrl: firstValue([envResolver.getEnv('BRAND_LOGO_URL'), configuredBranding.logoUrl, configuredBranding.logo_url, DEFAULT_BRANDING.logoUrl]),
    faviconUrl: firstValue([envResolver.getEnv('BRAND_FAVICON_URL'), configuredBranding.faviconUrl, configuredBranding.favicon_url, DEFAULT_BRANDING.faviconUrl]),
    faviconPng32Url: firstValue([envResolver.getEnv('BRAND_FAVICON_PNG_32_URL'), configuredBranding.faviconPng32Url, configuredBranding.favicon_png_32_url, DEFAULT_BRANDING.faviconPng32Url]),
    faviconPng16Url: firstValue([envResolver.getEnv('BRAND_FAVICON_PNG_16_URL'), configuredBranding.faviconPng16Url, configuredBranding.favicon_png_16_url, DEFAULT_BRANDING.faviconPng16Url]),
    appIconUrl: firstValue([envResolver.getEnv('BRAND_APP_ICON_URL'), configuredBranding.appIconUrl, configuredBranding.app_icon_url, DEFAULT_BRANDING.appIconUrl]),
    appleTouchIconUrl: firstValue([envResolver.getEnv('BRAND_APPLE_TOUCH_ICON_URL'), configuredBranding.appleTouchIconUrl, configuredBranding.apple_touch_icon_url, DEFAULT_BRANDING.appleTouchIconUrl]),
    manifestUrl: firstValue([envResolver.getEnv('BRAND_MANIFEST_URL'), configuredBranding.manifestUrl, configuredBranding.manifest_url, DEFAULT_BRANDING.manifestUrl]),
    senderEmail: firstValue([envResolver.getEnv('BRAND_SENDER_EMAIL'), envResolver.getEnv('APPLICATION_SENDER_EMAIL'), configuredBranding.senderEmail, configuredBranding.sender_email, config.get('application_sender_email'), DEFAULT_BRANDING.senderEmail]),
    senderName: firstValue([envResolver.getEnv('BRAND_SENDER_NAME'), configuredBranding.senderName, configuredBranding.sender_name, DEFAULT_BRANDING.senderName]),
  };

  branding.emailFrom = firstValue([
    envResolver.getEnv('BRAND_EMAIL_FROM'),
    configuredBranding.emailFrom,
    configuredBranding.email_from,
    formatEmailAddress({name: branding.senderName, email: branding.senderEmail}),
  ]);

  branding.oemActive = true;
  return branding;
};

const getEmailFrom = () => get().emailFrom;

// Test-only hook: clears the memoized entitlement decision so multi-outcome
// suites can re-evaluate after swapping LEAVEPILOT_LICENSE between cases. Not
// for production use.
const __resetOemCacheForTests = () => {
  _oemCache = null;
};

module.exports = {
  get,
  getEmailFrom,
  __resetOemCacheForTests,
};
