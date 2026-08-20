'use strict';

/*
  Boot-time checks for settings that are individually valid but wrong together.

  The one this exists for: a production deployment that terminates TLS upstream
  and tells the app so (TRUST_PROXY), while leaving SESSION_COOKIE_SECURE at its
  default of false. The session cookie then goes out with no Secure attribute, so
  any request the browser can be induced to make over plain HTTP to the same
  origin carries the session id in the clear.

  Nothing caught this. lib/config.js hard-fails on a missing SESSION_SECRET or
  CRYPTO_SECRET, but session_cookie_secure is read in a separate loop with no
  failure path, and config/app.json does not define it at all, so
  withSession.js falls through to false.

  This warns rather than throws, deliberately. The shipped docker-compose.yml
  defaults TRUST_PROXY to 1 and SESSION_COOKIE_SECURE to false, so every
  deployment using those defaults would stop booting on upgrade — a hostile way
  to deliver a hardening fix. Flipping the compose default to true is no better:
  the compose publishes the app port directly with no TLS terminator, so the
  out-of-the-box run is plain HTTP, and a Secure cookie there is a cookie the
  browser will not send, i.e. nobody can log in.

  So the operator is told, loudly and specifically, and decides.
*/

const TRUTHY = ['true', '1', 'yes', 'on'];
const FALSY = ['false', '0', 'no', 'off'];

// Matches parseBoolean in lib/middleware/withSession.js: a warning that read
// these values differently from the code that acts on them would be worse than
// no warning.
const toBoolean = (value, defaultValue) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalised = value.toLowerCase();

    if (TRUTHY.includes(normalised)) {
      return true;
    }

    if (FALSY.includes(normalised)) {
      return false;
    }
  }

  return defaultValue;
};

/*
  Returns the message an operator needs, or null when there is nothing to say.
  Kept separate from the logging so it can be tested without a boot.
*/
const describeSessionCookieRisk = ({isProductionLike, trustProxy, sessionCookieSecure}) => {
  if (!isProductionLike) {
    return null;
  }

  // Without a trusted proxy the app is either serving TLS itself or serving
  // plain HTTP directly. In the second case a Secure cookie would break login
  // outright, so its absence is not evidence of a misconfiguration.
  if (!toBoolean(trustProxy, false)) {
    return null;
  }

  if (toBoolean(sessionCookieSecure, false)) {
    return null;
  }

  return 'SESSION_COOKIE_SECURE is not set while TRUST_PROXY is on.'
    + ' TRUST_PROXY says TLS terminates in front of this app, so the session'
    + ' cookie should carry the Secure attribute and currently does not:'
    + ' any plaintext request to this origin would send the session id in the'
    + ' clear. Set SESSION_COOKIE_SECURE=true unless this deployment really is'
    + ' served over plain HTTP.';
};

const describeSessionCookieRiskStrict = (settings) => {
  const message = describeSessionCookieRisk(settings);
  if (!message) return null;
  return { level: 'error', message };
};

const reportSecurityPosture = (settings, logger) => {
  const warnings = [describeSessionCookieRisk(settings)].filter(Boolean);
  const write = (logger || console).warn;

  warnings.forEach(message => write.call(logger || console, 'security_posture: ' + message));

  return warnings;
};

module.exports = {
  describeSessionCookieRisk,
  describeSessionCookieRiskStrict,
  reportSecurityPosture,
  toBoolean,
};
