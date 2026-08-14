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
  let incompleteFields = null;

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

    if (active) {
      const incomplete = getIncompleteOemFields();
      if (incomplete.length > 0) {
        // CR-01 atomic application: a PARTIAL brand config must not render as a
        // hybrid of operator values and vendor defaults/placeholders — every
        // vendor-identity field the defaults carry must be explicitly rebranded
        // or the whole custom brand is rejected. This is the safe-fail branch:
        // the deployment shows the full default brand instead of leaking the
        // vendor through the unset fields (OEM-04).
        active = false;
        incompleteFields = incomplete;
        // Visible to the operator (log), not to end users. One line per boot:
        // this runs inside the memoized decision.
        // eslint-disable-next-line no-console
        console.warn(
          '[branding] OEM entitlement is valid but the brand config is INCOMPLETE —'
          + ' falling back to the default brand. Custom branding is applied'
          + ' atomically (all vendor-identity fields or none). Missing/placeholder fields: '
          + incomplete.join(', ')
          + '. Set them via BRAND_* env or the branding section of the config file.'
        );
      }
    }
  } catch (_error) {
    // OEM-02: the gate NEVER throws to the caller. Any license-verification
    // failure (missing / damaged / expired) resolves to the default brand.
    active = false;
  }

  _oemCache = {active, incompleteFields};
  return _oemCache;
};

// Vendor-identity fields: whose DEFAULT_BRANDING (and shipped config/app.json
// placeholder) value carries the vendor name/domains. Under OEM each must be
// explicitly rebranded; the shipped config placeholders are byte-identical to
// the defaults, so a field that still resolves to the default value counts as
// NOT rebranded.
const OEM_REQUIRED_FIELDS = [
  {key: 'name', env: 'BRAND_NAME'},
  {key: 'shortName', env: 'BRAND_SHORT_NAME'},
  {key: 'applicationDomain', env: 'APPLICATION_DOMAIN'},
  {key: 'promotionWebsiteDomain', env: 'PROMOTION_WEBSITE_DOMAIN'},
  {key: 'senderEmail', env: 'BRAND_SENDER_EMAIL'},
];

const getIncompleteOemFields = () => {
  const configuredBranding = config.get('branding') || {};

  // Each check resolves the SAME source chain the main get() uses (minus the
  // DEFAULT fallback), so a field rebranded through a legacy key
  // (short_name, application_domain, application_sender_email, …) counts as
  // rebranded here too.
  const resolved = {
    name: firstValue([envResolver.getEnv('BRAND_NAME'), configuredBranding.name]),
    shortName: firstValue([envResolver.getEnv('BRAND_SHORT_NAME'), configuredBranding.shortName, configuredBranding.short_name]),
    applicationDomain: firstValue([envResolver.getEnv('APPLICATION_DOMAIN'), configuredBranding.applicationDomain, configuredBranding.application_domain, config.get('application_domain')]),
    promotionWebsiteDomain: firstValue([envResolver.getEnv('PROMOTION_WEBSITE_DOMAIN'), configuredBranding.promotionWebsiteDomain, configuredBranding.promotion_website_domain, config.get('promotion_website_domain')]),
    senderEmail: firstValue([envResolver.getEnv('BRAND_SENDER_EMAIL'), envResolver.getEnv('APPLICATION_SENDER_EMAIL'), configuredBranding.senderEmail, configuredBranding.sender_email, config.get('application_sender_email')]),
  };

  return OEM_REQUIRED_FIELDS
    .filter(({key}) => resolved[key] === undefined || resolved[key] === '' || resolved[key] === DEFAULT_BRANDING[key])
    .map(({key}) => key);
};

const get = () => {
  const oem = getOemEntitlement();

  // D-04: without the custom_branding entitlement the operator's BRAND_* env
  // and config/app.json branding section are IGNORED — DEFAULT_BRANDING is the
  // only source. The license grants the RIGHT to ship a custom brand; it does
  // not change the community-edition default. (OEM-02: never throws.)
  // The CR-01 atomic rule reuses the same branch: an INCOMPLETE custom config
  // (any vendor-identity field unset or still on its placeholder) rejects the
  // whole custom brand — there is no hybrid state.
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

// Test-only hook: the last memoized decision (incl. the CR-01 incomplete-fields
// diagnosis) so a test can assert WHY the custom brand was rejected.
const __getLastOemDecisionForTests = () => _oemCache;

module.exports = {
  get,
  getEmailFrom,
  __resetOemCacheForTests,
  __getLastOemDecisionForTests,
};
