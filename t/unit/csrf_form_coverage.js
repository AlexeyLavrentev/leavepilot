'use strict';

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const authSecurity = require('../../lib/middleware/auth_security');

function filesUnder(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(target) : [target];
  });
}

describe('CSRF form coverage', function() {
  it('places a CSRF field in every server-rendered POST form', function() {
    const failures = [];
    filesUnder(path.join(__dirname, '..', '..', 'views'))
      .filter(file => file.endsWith('.hbs'))
      .forEach(file => {
        const source = fs.readFileSync(file, 'utf8');
        const formPattern = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
        let match;
        while ((match = formPattern.exec(source))) {
          const openingTag = match[0].match(/^<form\b[^>]*>/i)[0];
          if (/method=["']post["']/i.test(openingTag) && !/name=["']_csrf["']/i.test(match[0])) {
            failures.push(path.relative(path.join(__dirname, '..', '..'), file) + ': ' + openingTag);
          }
        }
      });
    expect(failures).to.deep.equal([]);
  });
});

/*
  CSRF exemption watchdog (QUAL-04, D-13) - a standing gate, not a one-time
  cleanup.

  The global pipeline verifier (authSecurity.verifyCsrfTokenGlobally, mounted
  in app.js) exempts exactly the paths in authSecurity.CSRF_EXEMPT_EXACT_PATHS.
  "Exempt" must mean "this route owns its CSRF protection some other way",
  never "nobody looks at CSRF here":

  - the login-family paths are verified by the route-local
    authSecurity.verifyCsrfToken mounted in lib/route/login.js - if one of
    those mounts is removed, the path becomes an open hole and this spec
    fails naming it;
  - routes receiving a POST binding from a third party that cannot carry
    our token (the SAML assertion consumer) are declared individually in
    THIRD_PARTY_POST_BINDINGS with the reason - if the declaration outlives
    its route, this spec fails too.

  Prefix exemptions (req.path.startsWith('/login') and friends) are the
  defect class that created the accidental-exemption hole in the first
  place: the detector below fails the build on any direct req.path prefix
  comparison against an exempt path anywhere under lib/ or in app.js.
  Computing a redirect target from a LOCAL path variable (as
  getFailureRedirect does) is not an exemption and is deliberately out of
  the detector's scope.

  Teeth run on synthetic input so the detectors themselves are proven
  non-vacuous without breaking real source.
*/
const THIRD_PARTY_POST_BINDINGS = {
  '/login/sso/callback/saml':
    'SAML POST binding: the IdP posts the response via the browser and cannot carry this app\'s CSRF token; the assertion is signature-verified by the SSO provider',
};

const REPO_ROOT = path.join(__dirname, '..', '..');
const LOGIN_ROUTE_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, 'lib', 'route', 'login.js'),
  'utf8'
);

function collectPipelineSources() {
  const files = filesUnder(path.join(REPO_ROOT, 'lib'))
    .filter(file => file.endsWith('.js'))
    .concat(path.join(REPO_ROOT, 'app.js'));

  return files.map(file => ({
    file: path.relative(REPO_ROOT, file),
    source: fs.readFileSync(file, 'utf8'),
  }));
}

/*
  Extract every `router.post('<path>', ...middleware..., handler)` mount from
  a router source string. The middleware slice runs from `router.post(` to
  the first handler token (`function` / `=>`), which is where
  authSecurity.verifyCsrfToken appears in the real mounts.
*/
function extractPostMounts(source) {
  const mounts = [];
  const marker = 'router.post(';
  let index = source.indexOf(marker);

  while (index !== -1) {
    const slice = source.slice(index, index + 600);
    const pathMatch = slice.match(/['"]([^'"]+)['"]/);
    const handlerAt = slice.search(/function|=>/);

    if (pathMatch) {
      mounts.push({
        path: pathMatch[1],
        hasRouteLocalVerifier: slice.slice(0, handlerAt === -1 ? slice.length : handlerAt)
          .indexOf('verifyCsrfToken') !== -1,
      });
    }

    index = source.indexOf(marker, index + marker.length);
  }

  return mounts;
}

function normalizeMountPath(mountPath) {
  return mountPath.length > 1 && mountPath.endsWith('/')
    ? mountPath.slice(0, -1)
    : mountPath;
}

/*
  Returns the exempt paths (sorted, deterministic) that are justified neither
  by a route-local verifyCsrfToken mount nor by a declared third-party POST
  binding whose route still exists.
*/
function findOrphanExemptPaths(exemptPaths, loginSource) {
  const mounts = extractPostMounts(loginSource);

  return exemptPaths.filter(exemptPath => {
    const normalized = normalizeMountPath(exemptPath);
    const mountForPath = mounts.filter(mount => normalizeMountPath(mount.path) === normalized);

    const protectedByRouteLocalMount = mountForPath.some(mount => mount.hasRouteLocalVerifier);
    const declaredThirdPartyBinding = Object.prototype.hasOwnProperty.call(THIRD_PARTY_POST_BINDINGS, exemptPath)
      && mountForPath.length > 0;

    return !protectedByRouteLocalMount && !declaredThirdPartyBinding;
  }).sort();
}

/*
  Returns direct prefix comparisons of req.path against an exempt path
  (both quote styles, startsWith and indexOf === 0 forms), sorted by file
  then line.
*/
function findPrefixExemptions(fileSources, exemptPaths) {
  const offenders = [];

  fileSources.forEach(({file, source}) => {
    source.split('\n').forEach((line, lineNumber) => {
      exemptPaths.forEach(exemptPath => {
        const forms = [
          "req.path.startsWith('" + exemptPath + "')",
          'req.path.startsWith("' + exemptPath + '")',
          "req.path.indexOf('" + exemptPath + "') === 0",
          'req.path.indexOf("' + exemptPath + '") === 0',
        ];

        if (forms.some(form => line.indexOf(form) !== -1)) {
          offenders.push({file: file, line: lineNumber + 1, match: line.trim()});
        }
      });
    });
  });

  return offenders.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
}

describe('CSRF exemption watchdog', function() {
  it('has a real surface to guard (surfaces exist)', function() {
    const exemptPaths = authSecurity.CSRF_EXEMPT_EXACT_PATHS;

    expect(exemptPaths).to.be.an('array');
    expect(exemptPaths.length).to.be.at.least(4);
    ['/login', '/register', '/forgot-password', '/reset-password'].forEach(pathName => {
      expect(exemptPaths, pathName + ' must stay in the exemption constant').to.include(pathName);
    });
    exemptPaths.forEach(pathName => {
      expect(pathName).to.be.a('string');
      expect(pathName.indexOf('/')).to.equal(0);
    });
    expect(LOGIN_ROUTE_SOURCE.length).to.be.above(0);
  });

  it('every globally-exempt path is protected route-locally or is a declared third-party binding', function() {
    const orphans = findOrphanExemptPaths(authSecurity.CSRF_EXEMPT_EXACT_PATHS, LOGIN_ROUTE_SOURCE);

    expect(
      orphans.map(orphan => orphan + ' is exempt from the global verifier without route-local protection'),
      'exempt paths must map to a verifyCsrfToken mount in lib/route/login.js or a declared binding'
    ).to.deep.equal([]);
  });

  it('no source under lib/ or app.js prefix-compares req.path against an exempt path', function() {
    expect(findPrefixExemptions(collectPipelineSources(), authSecurity.CSRF_EXEMPT_EXACT_PATHS))
      .to.deep.equal([]);
  });

  it('teeth: flags an exempt path whose mount lost the route-local verifier (synthetic source)', function() {
    const synthetic = [
      'router.post(',
      "  '/login',",
      '  authSecurity.setAuthSecurityHeaders,',
      '  function(req, res, next) { next(); }',
      ');',
    ].join('\n');

    expect(findOrphanExemptPaths(['/login'], synthetic)).to.deep.equal(['/login']);
  });

  it('teeth: flags an exempt path that has no mount at all (synthetic source)', function() {
    const synthetic = "router.post('/login', authSecurity.verifyCsrfToken, function() {});";

    expect(findOrphanExemptPaths(['/evil'], synthetic)).to.deep.equal(['/evil']);
  });

  it('teeth: accepts a declared third-party binding whose route still exists (synthetic source)', function() {
    const synthetic = "router.post('/login/sso/callback/saml', async function(req, res) {});";

    expect(findOrphanExemptPaths(['/login/sso/callback/saml'], synthetic)).to.deep.equal([]);
  });

  it('teeth: flags a declared binding whose route disappeared (synthetic source)', function() {
    const synthetic = "router.post('/login', authSecurity.verifyCsrfToken, function() {});";

    expect(findOrphanExemptPaths(['/login/sso/callback/saml'], synthetic))
      .to.deep.equal(['/login/sso/callback/saml']);
  });

  it('teeth: flags synthetic startsWith and indexOf prefix exemptions in file-then-line order', function() {
    const offenders = findPrefixExemptions([
      {file: 'lib/route/b.js', source: "  if (req.path.startsWith('/login')) {\n    return next();\n  }"},
      {file: 'lib/route/a.js', source: '  if (req.path.indexOf("/register") === 0) {\n    return next();\n  }'},
      {file: 'lib/route/b.js', source: 'later line\n  if (req.path.indexOf(\'/register\') === 0) { next(); }'},
    ], ['/login', '/register']);

    expect(offenders).to.deep.equal([
      {file: 'lib/route/a.js', line: 1, match: 'if (req.path.indexOf("/register") === 0) {'},
      {file: 'lib/route/b.js', line: 1, match: "if (req.path.startsWith('/login')) {"},
      {file: 'lib/route/b.js', line: 2, match: "if (req.path.indexOf('/register') === 0) { next(); }"},
    ]);
  });

  it('teeth: does not flag redirect-target computation on a local path variable', function() {
    const offenders = findPrefixExemptions([{
      file: 'lib/middleware/auth_security.js',
      source: [
        'const getFailureRedirect = (req) => {',
        '  const path = req.path || req.originalUrl || \'\';',
        "  if (path.indexOf('/login') === 0) {",
        "    return '/login/';",
        '  }',
        '};',
      ].join('\n'),
    }], ['/login']);

    expect(offenders).to.deep.equal([]);
  });

  it('teeth: does not flag prefix comparisons against non-exempt paths', function() {
    const offenders = findPrefixExemptions([{
      file: 'lib/route/other.js',
      source: "  if (req.path.startsWith('/settings')) { next(); }",
    }], ['/login']);

    expect(offenders).to.deep.equal([]);
  });
});
