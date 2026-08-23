'use strict';

const crypto = require('crypto');
const rateLimitStore = require('./rate_limit_store');
const log = require('../logger');

const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX = 10;

const tokensMatch = (sessionToken, requestToken) => {
  if (typeof sessionToken !== 'string' || typeof requestToken !== 'string') {
    return false;
  }

  const sessionBuffer = Buffer.from(sessionToken);
  const requestBuffer = Buffer.from(requestToken);
  return sessionBuffer.length === requestBuffer.length
    && crypto.timingSafeEqual(sessionBuffer, requestBuffer);
};

const shouldDeferMultipartCsrf = (req, isRegisteredRoute) => {
  return req.method === 'POST'
    && typeof req.is === 'function'
    && !!req.is('multipart/form-data')
    && typeof isRegisteredRoute === 'function'
    && isRegisteredRoute(req.method, req.path);
};

const getClientIp = (req) => {
  // Trust Express' resolved client IP (`req.ip`), which already honours the
  // configured `trust proxy` setting. Parsing X-Forwarded-For manually would let
  // any client spoof the header and bypass rate limiting when the app is not
  // behind a trusted proxy.
  return req.ip
    || req.connection && req.connection.remoteAddress
    || req.socket && req.socket.remoteAddress
    || 'unknown';
};

const getFailureRedirect = (req) => {
  const path = req.path || req.originalUrl || '';

  if (path.indexOf('/reset-password') === 0) {
    const token = (req.body && req.body.t) || (req.query && req.query.t) || '';
    return '/reset-password/?t=' + encodeURIComponent(token);
  }

  if (path.indexOf('/forgot-password') === 0) {
    return '/forgot-password/';
  }

  if (path.indexOf('/register') === 0) {
    return '/register/';
  }

  if (path.indexOf('/login/sso') === 0) {
    return '/login/sso/';
  }

  if (path.indexOf('/login') === 0) {
    return '/login/';
  }

  return '/';
};

const setAuthSecurityHeaders = (req, res, next) => {
  const headers = [
    ['X-Frame-Options', 'DENY'],
    ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'same-origin'],
    ['Cross-Origin-Opener-Policy', 'same-origin'],
    ['Cross-Origin-Resource-Policy', 'same-site'],
    /*
      No 'unsafe-inline'.

      With it in script-src the header was protecting against very little: an
      injected <script> runs exactly as the page's own scripts do, which is the
      one thing a CSP is most often deployed to stop. It was there because the
      layout and two settings pages carried their script inline; they link files
      now, and what the server has to pass to them is rendered as data in a
      <script type="application/json"> block, which the browser parses rather
      than executes and which script-src does not govern.

      style-src drops it too. The only inline styles left in the app were two
      progress bars, whose width comes from the value they already report to
      assistive technology, applied through the CSSOM - which CSP does not cover.
      Google's font stylesheet stays, since it is linked from the layout.
    */
    ['Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"],
  ];

  /*
    The portal sub-app has emitted HSTS since it was written
    (portal/web/security_headers.js); the main app never did, so the deployment
    holding the session cookie was the one telling browsers nothing about
    sticking to HTTPS.

    Conditional on req.secure, matching the portal. That is true for a direct TLS
    connection, and behind a proxy it follows X-Forwarded-Proto once trust proxy
    is set. On the plain-HTTP stack the shipped compose runs out of the box it is
    a no-op, which is correct: announcing HSTS from an origin that has no TLS
    would lock users out of it for a year.
  */
  if (req.secure) {
    headers.push(['Strict-Transport-Security', 'max-age=31536000; includeSubDomains']);
  }

  headers.forEach(([headerName, headerValue]) => {
    res.setHeader(headerName, headerValue);
  });

  next();
};

const attachCsrfToken = (req, res, next) => {
  if (!req.session) {
    throw new Error('CSRF protection requires session middleware');
  }

  if (!req.session.csrf_token) {
    req.session.csrf_token = crypto.randomBytes(32).toString('hex');
  }

  res.locals.csrf_token = req.session.csrf_token;
  next();
};

const verifyCsrfToken = (req, res, next) => {
  const sessionToken = req.session && req.session.csrf_token;
  const requestToken = req.body && req.body._csrf
    || req.headers && req.headers['x-csrf-token'];

  if (!sessionToken || !requestToken) {
    if (req.session && req.session.flash_error) {
      req.session.flash_error(req.t('login.messages.invalidCsrfToken'));
    }
    return res.redirect_with_session(getFailureRedirect(req));
  }

  if (!tokensMatch(sessionToken, requestToken)) {
    if (req.session && req.session.flash_error) {
      req.session.flash_error(req.t('login.messages.invalidCsrfToken'));
    }
    return res.redirect_with_session(getFailureRedirect(req));
  }

  return next();
};

/*
  Exact paths exempt from the GLOBAL CSRF verifier (D-13). "Exempt" means
  the route carries its own protection, not that CSRF is unchecked:

  - /login, /register, /forgot-password/, /reset-password/ are verified by
    the route-local verifyCsrfToken mounted in lib/route/login.js. The
    t/unit/csrf_form_coverage.js watchdog fails the build if any of them
    loses that mount.
  - /login/sso/callback/saml is the SAML assertion consumer: the identity
    provider POSTs the response through the user's browser, so the request
    cannot carry this app's CSRF token. The assertion itself is
    signature-verified by the SSO provider, which is the meaningful
    integrity check for that binding. (It used to be covered silently by
    the old startsWith('/login') prefix.)

  Membership is exact on purpose. Prefix matching here would silently
  exempt /login-anything-else.

  Every entry must spell its route exactly as lib/route/login.js mounts
  it, trailing slash included (G-05-3/WR-02): the runtime check below is
  includes(req.path), so an entry like /forgot-password against the mount
  /forgot-password/ never matches and the "exemption" silently degrades
  into double verification. The t/unit/csrf_form_coverage.js watchdog
  compares every entry with the real router.post mount
  character-for-character and fails the build on any drift.

  The list is a code contract and is deliberately not configurable.
*/
const CSRF_EXEMPT_EXACT_PATHS = Object.freeze([
  '/login',
  '/register',
  '/forgot-password/',
  '/reset-password/',
  '/login/sso/callback/saml',
]);

const verifyCsrfTokenGlobally = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  if (CSRF_EXEMPT_EXACT_PATHS.includes(req.path)) {
    return next();
  }

  // Registered multipart routes parse their body after this middleware and
  // perform the same constant-time token comparison as soon as fields exist.
  //
  // The multipart registry is resolved lazily: lib/edition transitively
  // pulls route modules that require this one, so a top-level require
  // would close a require cycle at module-load time.
  if (shouldDeferMultipartCsrf(req, require('../edition').isMultipartRoute)) {
    return next();
  }

  const sessionToken = req.session && req.session.csrf_token;
  const requestToken = req.body && req.body._csrf
    || req.headers && req.headers['x-csrf-token'];

  const rejectCsrf = function() {
    const wantsJson = req.xhr
      || /^\/api\//.test(req.originalUrl || req.url || '')
      || (req.accepts && req.accepts(['html', 'json']) === 'json');

    if (wantsJson) {
      return res.status(403).json({error: 'invalid_csrf'});
    }

    if (req.user && req.session && req.session.flash_error) {
      req.session.flash_error(req.t ? req.t('login.messages.invalidCsrfToken') : 'Invalid CSRF token');
    }

    return res.redirect_with_session(req.originalUrl || req.path || '/');
  };

  if (!sessionToken || !requestToken) {
    return rejectCsrf();
  }

  if (!tokensMatch(sessionToken, requestToken)) {
    return rejectCsrf();
  }

  return next();
};

const createAuthRateLimit = (options) => {
  if (process.env.DISABLE_AUTH_RATE_LIMIT === 'true') {
    if ((process.env.NODE_ENV || 'development') === 'production') {
      log.error(
        'WARNING: Authentication rate limiting is disabled via '
        + 'DISABLE_AUTH_RATE_LIMIT in production. This removes brute-force '
        + 'protection on login endpoints. Unset this variable to re-enable.'
      );
    }
    return (req, res, next) => next();
  }

  const windowMs = options && options.windowMs || DEFAULT_RATE_LIMIT_WINDOW_MS;
  const max = options && options.max || DEFAULT_RATE_LIMIT_MAX;
  const keyPrefix = options && options.keyPrefix || 'auth';

  return async (req, res, next) => {
    const key = keyPrefix + ':' + getClientIp(req);
    const sessionMiddleware = req.app && req.app.get('session_middleware');
    const result = await rateLimitStore.consume({
      key,
      windowMs,
      redisClient: sessionMiddleware && sessionMiddleware.rateLimitRedisClient,
    });

    if (result.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));

      res.setHeader('Retry-After', String(retryAfterSeconds));

      if (req.session && req.session.flash_error) {
        req.session.flash_error(req.t('login.messages.tooManyAuthAttempts', {
          seconds: retryAfterSeconds,
        }));
      }

      return res.redirect_with_session(getFailureRedirect(req));
    }

    return next();
  };
};

const createApiRateLimit = (options) => {
  const windowMs = options && options.windowMs || 60 * 1000;
  const max = options && options.max || 120;
  const keyPrefix = options && options.keyPrefix || 'api';

  return async (req, res, next) => {
    const authorization = String(req.headers && req.headers.authorization || '');
    const credentialHash = crypto.createHash('sha256').update(authorization).digest('hex');
    const clientIp = getClientIp(req);
    const sessionMiddleware = req.app && req.app.get('session_middleware');
    const redisClient = sessionMiddleware && sessionMiddleware.rateLimitRedisClient;
    const results = await Promise.all([
      rateLimitStore.consume({key: keyPrefix + ':ip:' + clientIp, windowMs, redisClient}),
      rateLimitStore.consume({key: keyPrefix + ':token:' + credentialHash, windowMs, redisClient}),
    ]);
    const blocked = results.find(result => result.count > max);

    if (blocked) {
      const retryAfterSeconds = Math.max(1, Math.ceil(blocked.retryAfterMs / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ok: false, error: 'rate_limit_exceeded'});
    }

    return next();
  };
};

const resetAuthRateLimitStore = () => {
  rateLimitStore.reset();
};

module.exports = {
  CSRF_EXEMPT_EXACT_PATHS,
  attachCsrfToken,
  createApiRateLimit,
  createAuthRateLimit,
  resetAuthRateLimitStore,
  setAuthSecurityHeaders,
  tokensMatch,
  shouldDeferMultipartCsrf,
  verifyCsrfToken,
  verifyCsrfTokenGlobally,
};
