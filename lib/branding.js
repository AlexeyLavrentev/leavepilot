'use strict';

const config = require('./config');
const envResolver = require('./env_resolver');

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

const get = () => {
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

  return branding;
};

const getEmailFrom = () => get().emailFrom;

module.exports = {
  get,
  getEmailFrom,
};
