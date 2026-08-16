'use strict';

const expect = require('chai').expect;
const flashMessages = require('../../../lib/middleware/flash_messages');
const authSecurity = require('../../../lib/middleware/auth_security');

function createReq(overrides) {
  const req = Object.assign({
    body: {},
    headers: {},
    app: {get: function() { return null; }},
    path: '/login',
    session: {},
    t(key, params) {
      if (key === 'login.messages.invalidCsrfToken') {
        return 'Your form session expired. Please try again.';
      }

      if (key === 'login.messages.tooManyAuthAttempts') {
        return 'Too many authentication attempts. Please try again in ' + params.seconds + ' seconds.';
      }

      return key;
    },
  }, overrides || {});

  flashMessages(req, { locals: {} }, function() {});

  return req;
}

function createRes() {
  return {
    headers: {},
    locals: {},
    redirects: [],
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    redirect_with_session(location) {
      this.redirects.push(location);
      return location;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
}

describe('auth security middleware', function() {
  beforeEach(function() {
    authSecurity.resetAuthRateLimitStore();
  });

  it('attaches CSP and related security headers', function(done) {
    const res = createRes();

    authSecurity.setAuthSecurityHeaders(createReq(), res, function() {
      expect(res.headers['X-Frame-Options']).to.equal('DENY');
      expect(res.headers['X-Content-Type-Options']).to.equal('nosniff');
      expect(res.headers['Content-Security-Policy']).to.contain("frame-ancestors 'none'");
      done();
    });
  });

  /*
    The portal sub-app has emitted HSTS since it was written; the main app never
    did, so the deployment holding the session cookie was the one telling
    browsers nothing about staying on HTTPS.
  */
  it('adds HSTS once the request arrives over TLS', function(done) {
    const res = createRes();

    authSecurity.setAuthSecurityHeaders(createReq({secure: true}), res, function() {
      expect(res.headers['Strict-Transport-Security'])
        .to.equal('max-age=31536000; includeSubDomains');
      done();
    });
  });

  /*
    The shipped compose publishes the app port directly with no TLS terminator,
    so the out-of-the-box run is plain HTTP. Announcing HSTS from an origin with
    no TLS would lock its users out for a year.
  */
  it('withholds HSTS on a plaintext request', function(done) {
    const res = createRes();

    authSecurity.setAuthSecurityHeaders(createReq({secure: false}), res, function() {
      expect(res.headers).to.not.have.property('Strict-Transport-Security');
      done();
    });
  });

  it('creates and exposes csrf token in session and templates', function(done) {
    const req = createReq();
    const res = createRes();

    authSecurity.attachCsrfToken(req, res, function() {
      expect(req.session.csrf_token).to.be.a('string');
      expect(res.locals.csrf_token).to.equal(req.session.csrf_token);
      done();
    });
  });

  it('rejects invalid csrf token for login form', function() {
    const req = createReq({
      body: {
        _csrf: 'invalid-token',
      },
      session: {
        csrf_token: 'expected-token',
      },
    });
    const res = createRes();

    authSecurity.verifyCsrfToken(req, res, function() {
      throw new Error('next should not be called');
    });

    expect(res.redirects).to.deep.equal(['/login/']);
    expect(req.session.flash.errors).to.deep.equal([
      'Your form session expired. Please try again.',
    ]);
  });

  it('compares CSRF tokens safely for delayed multipart parsing', function() {
    expect(authSecurity.tokensMatch('expected-token', 'expected-token')).to.equal(true);
    expect(authSecurity.tokensMatch('expected-token', 'invalid-token')).to.equal(false);
    expect(authSecurity.tokensMatch('expected-token', undefined)).to.equal(false);
  });

  it('defers CSRF only for an exact registered multipart POST route', function() {
    const registered = function(method, path) {
      return method === 'POST' && path === '/users/import/';
    };
    const request = createReq({
      method: 'POST',
      path: '/users/import/',
      is: function(type) { return type === 'multipart/form-data' ? 'multipart/form-data' : false; },
    });

    expect(authSecurity.shouldDeferMultipartCsrf(request, registered)).to.equal(true);
    expect(authSecurity.shouldDeferMultipartCsrf(Object.assign({}, request, {path: '/users/import'}), registered)).to.equal(false);
    expect(authSecurity.shouldDeferMultipartCsrf(Object.assign({}, request, {method: 'GET'}), registered)).to.equal(false);
    expect(authSecurity.shouldDeferMultipartCsrf(Object.assign({}, request, {is: function() { return false; }}), registered)).to.equal(false);
  });

  it('limits repeated auth attempts by client ip', async function() {
    const limiter = authSecurity.createAuthRateLimit({
      max: 1,
      windowMs: 60 * 1000,
      keyPrefix: 'test-login',
    });
    const req = createReq({
      headers: {
        'x-forwarded-for': '203.0.113.10',
      },
    });
    const firstRes = createRes();
    const secondRes = createRes();
    let firstAllowed = false;

    await limiter(req, firstRes, function() {
      firstAllowed = true;
    });

    await limiter(req, secondRes, function() {
      throw new Error('second request should be blocked');
    });

    expect(firstAllowed).to.equal(true);
    expect(secondRes.headers['Retry-After']).to.equal('60');
    expect(secondRes.redirects).to.deep.equal(['/login/']);
    expect(req.session.flash.errors).to.deep.equal([
      'Too many authentication attempts. Please try again in 60 seconds.',
    ]);
  });

  it('keys rate limiting on req.ip so a spoofed X-Forwarded-For cannot bypass it', async function() {
    const limiter = authSecurity.createAuthRateLimit({
      max: 2,
      windowMs: 60 * 1000,
      keyPrefix: 'test-spoof',
    });

    // Same real client (req.ip), attacker rotates X-Forwarded-For each request.
    async function attempt(spoofedXff) {
      const req = createReq({
        ip: '10.0.0.5',
        headers: { 'x-forwarded-for': spoofedXff },
      });
      const res = createRes();
      let allowed = false;

      await limiter(req, res, function() {
        allowed = true;
      });

      return { allowed: allowed, res: res };
    }

    expect((await attempt('1.1.1.1')).allowed).to.equal(true);
    expect((await attempt('2.2.2.2')).allowed).to.equal(true);

    const third = await attempt('3.3.3.3');
    expect(third.allowed).to.equal(false);
    expect(third.res.headers['Retry-After']).to.equal('60');
  });

  it('returns JSON 429 for repeated bearer API requests', async function() {
    const limiter = authSecurity.createApiRateLimit({max: 1, windowMs: 60000});
    const req = createReq({
      ip: '10.0.0.8',
      headers: {authorization: 'Bearer secret-token'},
    });

    await limiter(req, createRes(), function() {});
    const blocked = createRes();
    await limiter(req, blocked, function() {
      throw new Error('second API request should be blocked');
    });

    expect(blocked.statusCode).to.equal(429);
    expect(blocked.body).to.deep.equal({ok: false, error: 'rate_limit_exceeded'});
    expect(blocked.headers['Retry-After']).to.equal('60');
  });

  it('cannot bypass API limit by rotating bearer credentials', async function() {
    const limiter = authSecurity.createApiRateLimit({max: 1, windowMs: 60000});
    const first = createReq({
      ip: '10.0.0.9',
      headers: {authorization: 'Bearer first-token'},
    });
    const rotated = createReq({
      ip: '10.0.0.9',
      headers: {authorization: 'Bearer rotated-token'},
    });

    await limiter(first, createRes(), function() {});
    const blocked = createRes();
    await limiter(rotated, blocked, function() {
      throw new Error('rotated token should still hit IP limit');
    });

    expect(blocked.statusCode).to.equal(429);
  });
});

/*
  The global CSRF pipeline verifier (QUAL-04).

  It used to live inline in app.js while this module carried a second,
  weaker copy mounted route-locally; the two drifted (RESEARCH Pitfall 3).
  The matrix below enumerates EVERY branch of BOTH legacy copies, so the
  merged export cannot quietly narrow either one:

  - method gate (GET/HEAD/OPTIONS pass) - inline copy only
  - exact-path exemptions - inline copy had startsWith prefixes
  - multipart deferral via the edition registry - inline copy only
  - JSON-aware 403 rejection - inline copy only
  - flash + redirect_with_session rejection - both copies
*/
describe('global CSRF verifier', function() {
  function createPostReq(overrides) {
    return createReq(Object.assign({
      method: 'POST',
      path: '/requests/leave/',
      originalUrl: '/requests/leave/',
    }, overrides || {}));
  }

  function multipartIs(type) {
    return function(requested) {
      return requested === type ? type : false;
    };
  }

  it('exports the exact-path exemption list frozen with exactly the agreed entries', function() {
    expect(authSecurity.CSRF_EXEMPT_EXACT_PATHS).to.be.an('array');
    expect(Object.isFrozen(authSecurity.CSRF_EXEMPT_EXACT_PATHS)).to.equal(true);
    expect(authSecurity.CSRF_EXEMPT_EXACT_PATHS).to.deep.equal([
      '/login',
      '/register',
      /*
        G-05-3/WR-02: the trailing-slash forms are the mounted ones
        (lib/route/login.js registers router.post('/forgot-password/') and
        router.post('/reset-password/')). The slash-less spellings never
        matched includes(req.path), so those routes were verified twice
        while the constant claimed they were exempt.
      */
      '/forgot-password/',
      '/reset-password/',
      /*
        Fifth entry, not in the original D-13 list of four: the SAML
        assertion consumer. The identity provider POSTs the response
        through the user's browser, so this one route cannot carry the
        app's CSRF token; the assertion is signature-verified by the SSO
        provider instead. Before the merge it was silently covered by the
        old startsWith('/login') prefix; exact matching would have broken
        every SAML login (deviation, documented in 05-02-SUMMARY.md).
      */
      '/login/sso/callback/saml',
    ]);
  });

  it('passes GET, HEAD and OPTIONS through regardless of tokens', function() {
    ['GET', 'HEAD', 'OPTIONS'].forEach(method => {
      let passed = false;
      authSecurity.verifyCsrfTokenGlobally(
        createPostReq({method: method, session: {}}),
        createRes(),
        function() { passed = true; }
      );
      expect(passed, method + ' should pass the method gate').to.equal(true);
    });
  });

  it('exempts every path in the frozen constant on exact membership', function() {
    authSecurity.CSRF_EXEMPT_EXACT_PATHS.forEach(exemptPath => {
      let passed = false;
      authSecurity.verifyCsrfTokenGlobally(
        createPostReq({path: exemptPath, originalUrl: exemptPath, session: {}}),
        createRes(),
        function() { passed = true; }
      );
      expect(passed, exemptPath + ' should be exempt by exact membership').to.equal(true);
    });
  });

  it('rejects prefixed non-members - there are no startsWith semantics', function() {
    [
      '/login-extra',
      '/register-foo',
      '/forgot-passwordx',
      // G-05-3: the slash-less spellings are drift, not membership - only
      // the exact mounted forms are exempt.
      '/forgot-password',
      '/reset-password',
      '/login/sso/callback/saml/extrapath',
    ].forEach(path => {
      const req = createPostReq({path: path, originalUrl: path, session: {}});
      const res = createRes();

      authSecurity.verifyCsrfTokenGlobally(req, res, function() {
        throw new Error(path + ' must not pass the global verifier');
      });

      expect(res.redirects, path + ' should be rejected to a redirect').to.deep.equal([path]);
    });
  });

  it('returns JSON 403 without redirect for an xhr request', function() {
    const req = createPostReq({xhr: true, session: {}});
    const res = createRes();

    authSecurity.verifyCsrfTokenGlobally(req, res, function() {
      throw new Error('missing token must be rejected');
    });

    expect(res.statusCode).to.equal(403);
    expect(res.body).to.deep.equal({error: 'invalid_csrf'});
    expect(res.redirects).to.deep.equal([]);
  });

  it('returns JSON 403 for a request whose originalUrl is under /api/', function() {
    const req = createPostReq({originalUrl: '/api/v1/requests/', session: {}});
    const res = createRes();

    authSecurity.verifyCsrfTokenGlobally(req, res, function() {
      throw new Error('missing token must be rejected');
    });

    expect(res.statusCode).to.equal(403);
    expect(res.body).to.deep.equal({error: 'invalid_csrf'});
    expect(res.redirects).to.deep.equal([]);
  });

  it('returns JSON 403 for a client that prefers json over html', function() {
    const req = createPostReq({
      accepts: types => types.indexOf('json') !== -1 ? 'json' : 'html',
      session: {},
    });
    const res = createRes();

    authSecurity.verifyCsrfTokenGlobally(req, res, function() {
      throw new Error('missing token must be rejected');
    });

    expect(res.statusCode).to.equal(403);
    expect(res.body).to.deep.equal({error: 'invalid_csrf'});
    expect(res.redirects).to.deep.equal([]);
  });

  it('flashes and redirects for an authenticated HTML request without a token', function() {
    const req = createPostReq({
      user: {id: 42},
      session: {csrf_token: 'session-token'},
    });
    const res = createRes();

    authSecurity.verifyCsrfTokenGlobally(req, res, function() {
      throw new Error('missing request token must be rejected');
    });

    expect(res.redirects).to.deep.equal(['/requests/leave/']);
    expect(req.session.flash.errors).to.deep.equal([
      'Your form session expired. Please try again.',
    ]);
  });

  it('redirects anonymous HTML requests without flashing', function() {
    const req = createPostReq({session: {}});
    const res = createRes();

    authSecurity.verifyCsrfTokenGlobally(req, res, function() {
      throw new Error('missing token must be rejected');
    });

    expect(res.redirects).to.deep.equal(['/requests/leave/']);
    // flash_error is never called, so no flash entry is ever created
    expect(req.session.flash).to.equal(undefined);
  });

  it('accepts a matching body token', function() {
    let passed = false;
    authSecurity.verifyCsrfTokenGlobally(
      createPostReq({
        session: {csrf_token: 'session-token'},
        body: {_csrf: 'session-token'},
      }),
      createRes(),
      function() { passed = true; }
    );
    expect(passed).to.equal(true);
  });

  it('accepts a matching x-csrf-token header', function() {
    let passed = false;
    authSecurity.verifyCsrfTokenGlobally(
      createPostReq({
        session: {csrf_token: 'session-token'},
        headers: {'x-csrf-token': 'session-token'},
      }),
      createRes(),
      function() { passed = true; }
    );
    expect(passed).to.equal(true);
  });

  it('rejects a mismatched token on the JSON branch', function() {
    const req = createPostReq({
      xhr: true,
      session: {csrf_token: 'session-token'},
      body: {_csrf: 'attacker-token'},
    });
    const res = createRes();

    authSecurity.verifyCsrfTokenGlobally(req, res, function() {
      throw new Error('mismatched token must be rejected');
    });

    expect(res.statusCode).to.equal(403);
    expect(res.body).to.deep.equal({error: 'invalid_csrf'});
  });

  it('defers verification for a registered multipart route before the body is parsed', function() {
    let passed = false;
    authSecurity.verifyCsrfTokenGlobally(
      createPostReq({
        path: '/users/import/',
        originalUrl: '/users/import/',
        session: {},
        is: multipartIs('multipart/form-data'),
      }),
      createRes(),
      function() { passed = true; }
    );
    expect(passed).to.equal(true);
  });

  it('does not defer for a multipart POST that is not a registered route', function() {
    const req = createPostReq({
      path: '/attacker/import/',
      originalUrl: '/attacker/import/',
      session: {},
      is: multipartIs('multipart/form-data'),
    });
    const res = createRes();

    authSecurity.verifyCsrfTokenGlobally(req, res, function() {
      throw new Error('unregistered multipart POST must not be deferred');
    });

    expect(res.redirects).to.deep.equal(['/attacker/import/']);
  });
});
