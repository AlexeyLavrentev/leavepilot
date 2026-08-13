'use strict';

// License-status -> UI bucket mapper.
//
// This is a read-and-render layer over the already-verified license machinery
// in lib/features.js. It does NOT re-derive parse/verify/expiry/grace logic:
// it reads the already-computed status fields produced by
// features.getLicenseStatus() and shapes a one-line view model for the
// admin-only settings partial (views/partials/settings_company_license.hbs).
//
// The shape mirrors lib/diagnostics.js collect(): a plain function returning a
// plain object, no class, no side effects.
//
// IMPORTANT (CONTEXT D-09): there is NO 'trial' branch and NO 'trial' UI bucket.
// Portal-issued trials carry plan:'enterprise' with no trial marker in the
// signed payload, so a trial is indistinguishable from a paid enterprise license
// at this layer. A trial therefore flows through the normal valid-license path:
// it lands in the 'active' bucket when it has runway beyond the expiring
// threshold, or in the 'expiring' bucket when it is within the threshold
// (the countdown is covered by the existing expiring path).

// Carries the deleted banner's 60-day "expiring soon" threshold (Claude's
// discretion per CONTEXT).
const EXPIRING_THRESHOLD_DAYS = 60;

// Reads ONLY non-secret status fields (valid/reason/source/plan/inGrace/
// daysUntilExpiry/expires/graceEndsAt) and branding.{name,promotionWebsiteDomain}.
// It never reads keyId/publicKey/signature material.
function mapLicenseStatusToUiBucket(status, branding) {
  const safeStatus = status || {};
  const safeBranding = branding || {};
  const upsellUrl = safeBranding.promotionWebsiteDomain || '';

  // 1. No license present -> Community Edition (free).
  if (safeStatus.source === 'none') {
    return {
      tone: 'neutral',
      textKey: 'licenseStatus.community',
      upsellKey: 'licenseStatus.upsellCommunity',
      upsellUrl,
      vars: { brand: safeBranding.name },
    };
  }

  // 2. Revoked -> distinct negative bucket (checked before the generic error
  //    branch because 'revoked' is also !valid && reason !== 'expired').
  if (safeStatus.reason === 'revoked') {
    return {
      tone: 'negative',
      textKey: 'licenseStatus.revoked',
      upsellKey: 'licenseStatus.upsellContact',
      upsellUrl,
      vars: {},
    };
  }

  // 3. Any other invalid status -> single FUNNEL-02 error bucket; the technical
  //    reason is exposed to the admin for action.
  if (!safeStatus.valid && safeStatus.reason !== 'expired') {
    return {
      tone: 'negative',
      textKey: 'licenseStatus.error',
      upsellKey: 'licenseStatus.upsellCommunity',
      upsellUrl,
      vars: { reason: safeStatus.reason },
    };
  }

  // 4. Expired but still within the grace window -> premium still works until
  //    graceEndsAt; warning tone.
  if (safeStatus.inGrace) {
    return {
      tone: 'warning',
      textKey: 'licenseStatus.grace',
      upsellKey: 'licenseStatus.upsellRenew',
      upsellUrl,
      vars: { expires: safeStatus.expires, graceEndsAt: safeStatus.graceEndsAt },
    };
  }

  // 5. Expired past the grace window -> negative.
  if (safeStatus.reason === 'expired') {
    return {
      tone: 'negative',
      textKey: 'licenseStatus.expired',
      upsellKey: 'licenseStatus.upsellRenew',
      upsellUrl,
      vars: {},
    };
  }

  // 6. Valid but expiring soon (within the threshold) -> warning.
  if (safeStatus.valid
      && safeStatus.daysUntilExpiry !== null
      && safeStatus.daysUntilExpiry >= 0
      && safeStatus.daysUntilExpiry <= EXPIRING_THRESHOLD_DAYS) {
    return {
      tone: 'warning',
      textKey: 'licenseStatus.expiring',
      upsellKey: 'licenseStatus.upsellRenew',
      upsellUrl,
      vars: { days: safeStatus.daysUntilExpiry, expires: safeStatus.expires },
    };
  }

  // 7. Otherwise -> active/valid (includes portal trials, which carry
  //    plan:'enterprise' and no trial marker; see D-09 above).
  return {
    tone: 'positive',
    textKey: 'licenseStatus.active',
    upsellKey: 'licenseStatus.manage',
    upsellUrl,
    vars: { plan: safeStatus.plan || '' },
  };
}

module.exports = {
  mapLicenseStatusToUiBucket,
  EXPIRING_THRESHOLD_DAYS,
};
