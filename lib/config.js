
'use strict';

var nconf = require('nconf');
var isCommercialEdition = require('./edition/commercial_mode').isCommercialEdition;
var nodeEnv = process.env.NODE_ENV || 'development';
var isProductionLike = ['production', 'staging'].indexOf(nodeEnv) !== -1
  || isCommercialEdition();
var missingSecrets = [];

nconf
  .argv()
  .file('localisation', { file: __dirname+'/../config/localisation.json' })
  .file({ file: __dirname+'/../config/app.json' });

[
  {
    configKey: 'session_secret',
    envKey: 'SESSION_SECRET',
    fallbackValue: 'timeoff-development-session-secret',
  },
  {
    configKey: 'crypto_secret',
    envKey: 'CRYPTO_SECRET',
    fallbackValue: 'timeoff-development-crypto-secret',
  },
].forEach(function(secretConfig) {
  if (process.env[secretConfig.envKey]) {
    nconf.set(secretConfig.configKey, process.env[secretConfig.envKey]);
    return;
  }

  if (isProductionLike) {
    missingSecrets.push(secretConfig.envKey);
    return;
  }

  nconf.set(secretConfig.configKey, secretConfig.fallbackValue);
});

if (missingSecrets.length) {
  throw new Error(
    'Missing required environment variables for secrets: '
      + missingSecrets.join(', ')
      + '.'
  );
}

[
  { configKey: 'trust_proxy', envKey: 'TRUST_PROXY' },
  { configKey: 'session_cookie_secure', envKey: 'SESSION_COOKIE_SECURE' },
  { configKey: 'session_cookie_same_site', envKey: 'SESSION_COOKIE_SAME_SITE' },
  { configKey: 'session_cookie_max_age_ms', envKey: 'SESSION_COOKIE_MAX_AGE_MS' },
  { configKey: 'allow_create_new_accounts', envKey: 'ALLOW_CREATE_NEW_ACCOUNTS' },
].forEach(function(runtimeConfig) {
  if (typeof process.env[runtimeConfig.envKey] !== 'undefined') {
    nconf.set(runtimeConfig.configKey, process.env[runtimeConfig.envKey]);
  }
});

// Settings that are each valid on their own but wrong in combination. Reported
// once at boot rather than thrown, because the shipped compose defaults would
// otherwise stop every existing deployment on upgrade. See lib/security_posture.js.
require('./security_posture').reportSecurityPosture({
  isProductionLike: isProductionLike,
  trustProxy: nconf.get('trust_proxy'),
  sessionCookieSecure: nconf.get('session_cookie_secure'),
});

module.exports = nconf;
