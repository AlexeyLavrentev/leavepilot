'use strict';

/*
  Guard for the demo stand's compose contract (plan 06-03, INSTALL-03).

  `npm run demo` (bin/demo.js) raises docker-compose.demo.yml - a whole-file
  variation of docker-compose.community-image.yml (D-09: the demo shows
  exactly the delivery a customer receives). The wrapper trusts the compose
  file for the stand's mechanics; this spec pins those mechanics so a future
  edit cannot silently break the one-command promise:

  - the image must stay parameterized as
    ${LEAVEPILOT_IMAGE:-ghcr.io/alexeylavrentev/leavepilot-community:latest}
    (D-09/D-21): before the first tag the stand boots a locally built image
    carrying that same tag, and after the tag it boots the published one -
    zero publish-workflow edits either way;
  - pull_policy must stay ${LEAVEPILOT_DEMO_PULL_POLICY:-missing}, NOT the
    community template's hardcoded `always`: a mandatory GHCR pull of a tag
    that does not exist yet would fail `up` on the pre-tag local build - the
    exact lever the deliberate divergence from the template exists for;
  - SESSION_SECRET/CRYPTO_SECRET carry demo-only
    ${VAR:-demo-...-not-for-production} defaults, NOT the template's
    ${VAR:?required} guards: `npm run demo` is a one-command promise, so a
    fresh clone with no .env and no exported secrets must interpolate
    cleanly - a `:?` guard fails interpolation for EVERY compose command
    (the wrapper's step-1 reset included) before anything runs (CR-01). The
    not-for-production markers keep the placeholder values from being
    mistaken for real secrets, and the production compose files keep the
    hard guards (pinned below so the loosening cannot leak there);
  - the host port must default to 3001 (DEMO_PORT lever) so the
    demo stand coexists with the install-check stand / a dev server on 3000;
  - the brand env passthrough must keep EMPTY defaults so the demo renders
    the default LeavePilot brand (screenshot prerequisite, D-13/D-14);
  - the service_healthy depends_on wiring keeps the app from booting before
    db/redis accept connections.

  Parsed as text with exact-line predicates - the same technique
  t/unit/compose_brand_env.js uses for the compose files, no YAML dependency.

  Read-only: the spec never writes docker-compose.demo.yml. The teeth specs
  mutate FABRICATED in-memory copies, never the file on disk.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const COMPOSE_FILE = 'docker-compose.demo.yml';

const read = () => fs.readFileSync(path.join(root, COMPOSE_FILE), 'utf8');

// The exact lines the D-09/D-21 lever is made of. Anything else on these
// lines - a hardwired local image, a re-tagged default, a hardcoded
// pull_policy - changes which artifact the demo shows or breaks the pre-tag
// boot, so they are pinned literally.
const IMAGE_LINE = 'image: ${LEAVEPILOT_IMAGE:-ghcr.io/alexeylavrentev/leavepilot-community:latest}';
const PULL_POLICY_LINE = 'pull_policy: ${LEAVEPILOT_DEMO_PULL_POLICY:-missing}';

// The brand passthrough surface: the same authoritative 15 names
// t/unit/compose_brand_env.js enumerates from lib/branding.js get(). Empty
// defaults are the point here - the demo must render the DEFAULT brand.
const BRAND_VARS = [
  'BRAND_NAME',
  'BRAND_SHORT_NAME',
  'BRAND_LOGO_URL',
  'BRAND_FAVICON_URL',
  'BRAND_FAVICON_PNG_32_URL',
  'BRAND_FAVICON_PNG_16_URL',
  'BRAND_APP_ICON_URL',
  'BRAND_APPLE_TOUCH_ICON_URL',
  'BRAND_MANIFEST_URL',
  'BRAND_SENDER_EMAIL',
  'APPLICATION_SENDER_EMAIL',
  'BRAND_SENDER_NAME',
  'BRAND_EMAIL_FROM',
  'APPLICATION_DOMAIN',
  'PROMOTION_WEBSITE_DOMAIN',
];

function escapeRegexp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True when `content` contains the literal `line` as a whole line (leading
// indentation allowed, nothing else on it). Used for the two pinned lever
// lines, where any edit is a contract change.
const hasExactLine = (content, line) => {
  return new RegExp('^[ \\t]*' + escapeRegexp(line) + '[ \\t]*$', 'm').test(content);
};

// True when `content` carries `NAME: ${NAME:?...}` - the compose required-
// variable guard. The message content is free; the :? form is the contract.
// Used for the PRODUCTION compose files; the demo file deliberately does not
// carry these (fresh-clone interpolation, CR-01).
const hasRequiredGuard = (content, name) => {
  return new RegExp(
    '^[ \\t]*' + escapeRegexp(name) + ':[ \\t]*\\$\\{' + escapeRegexp(name) + ':\\?[^}]+\\}[ \\t]*$',
    'm'
  ).test(content);
};

// True when `content` carries `NAME: ${NAME:-demo-...-not-for-production}` -
// the demo-only secret default. The `:-` form (not the production `:?`
// guard) is the fresh-clone contract; the non-empty default prefixed with
// `demo-` and suffixed `not-for-production` is the "never mistakable for a
// real secret, never an empty value" contract.
const hasDemoSecretDefault = (content, name) => {
  return new RegExp(
    '^[ \\t]*' + escapeRegexp(name) + ':[ \\t]*\\$\\{' + escapeRegexp(name)
      + ':-demo-[^}]*not-for-production\\}[ \\t]*$',
    'm'
  ).test(content);
};

// The production compose files that must keep the hard ${VAR:?} guards: the
// demo-only `:-` loosening exists ONLY for the disposable local stand.
const PRODUCTION_COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.community-image.yml'];

// True when `content` carries `NAME: ${NAME:-}` - empty-default passthrough.
// Same predicate shape as compose_brand_env.js hasBrandVar.
const hasEmptyDefault = (content, name) => {
  return new RegExp(
    '^[ \\t]*' + escapeRegexp(name) + ':[ \\t]*\\$\\{' + escapeRegexp(name) + ':-\\}[ \\t]*$',
    'm'
  ).test(content);
};

// True when the app service declares `service_name:` with
// `condition: service_healthy` under depends_on - the wiring that keeps the
// app from booting before db/redis accept connections.
const hasHealthyDependency = (content, service) => {
  return new RegExp(
    '^[ \\t]+depends_on:[^]*?^[ \\t]+' + escapeRegexp(service) + ':[ \\t]*\\n[ \\t]+condition: service_healthy[ \\t]*$',
    'm'
  ).test(content);
};

describe('demo compose contract (docker-compose.demo.yml, plan 06-03)', function() {

  it('has the surface to check', function() {
    // Non-vacuous guard (compose_brand_env.js precedent): if the demo
    // compose file were deleted or renamed, the specs below would pass
    // trivially against nothing.
    expect(
      fs.existsSync(path.join(root, COMPOSE_FILE)),
      COMPOSE_FILE + ' is gone, so this guard has nothing to check'
    ).to.equal(true);
    expect(read().length).to.be.above(0);
  });

  it('declares name leavepilot-demo with services db/redis/app and service_healthy wiring for db and redis', function() {
    const content = read();

    // Project isolation: the top-level name prefixes containers and volumes
    // so the demo never collides with a real deploy or the install-check
    // stand of the same compose CLI.
    expect(
      content,
      'top-level name must be leavepilot-demo (stand isolation)'
    ).to.match(/^name:[ \t]*leavepilot-demo[ \t]*$/m);

    ['db', 'redis', 'app'].forEach(service => {
      expect(
        content,
        'the ' + service + ' service is missing from docker-compose.demo.yml'
      ).to.match(new RegExp('^[ \\t]+' + service + ':[ \\t]*$', 'm'));
    });

    ['db', 'redis'].forEach(service => {
      expect(
        hasHealthyDependency(content, service),
        'app must depend on ' + service + ' with condition: service_healthy'
      ).to.equal(true);
    });
  });

  it('keeps the D-09/D-21 image lever: parameterized image and pull_policy missing (a hardcoded pull_policy: always fails)', function() {
    const content = read();

    expect(
      hasExactLine(content, IMAGE_LINE),
      'the app image line must be exactly "' + IMAGE_LINE + '" - a hardwired image breaks the pre-tag local-build lever (D-21) and the delivery parity (D-09)'
    ).to.equal(true);

    expect(
      hasExactLine(content, PULL_POLICY_LINE),
      'the pull_policy line must be exactly "' + PULL_POLICY_LINE + '" - the community template\'s hardcoded `always` would fail a mandatory GHCR pull of the not-yet-published tag'
    ).to.equal(true);

    // Teeth for the pull_policy half (the test-2 negative control): on a
    // fabricated copy carrying the template's `pull_policy: always`, the
    // predicate must be false - proving the pin above rejects the exact
    // regression it exists to catch, not just any line change.
    const templateStyle = content.replace(
      new RegExp('^[ \\t]*' + escapeRegexp(PULL_POLICY_LINE) + '[ \\t]*$', 'm'),
      '    pull_policy: always'
    );
    expect(
      templateStyle,
      'sanity check: the fabricated template-style mutation must change the content'
    ).to.not.equal(content);
    expect(hasExactLine(templateStyle, PULL_POLICY_LINE)).to.equal(false);
  });

  it('defaults SESSION_SECRET and CRYPTO_SECRET to demo-only not-for-production values (fresh clone interpolates with no .env)', function() {
    const content = read();

    ['SESSION_SECRET', 'CRYPTO_SECRET'].forEach(name => {
      expect(
        hasDemoSecretDefault(content, name),
        name + ' must use the ${' + name + ':-demo-...-not-for-production} demo default - the production files\' :? guard fails compose interpolation on a fresh clone (no .env, no exported secrets) for every command, including the wrapper\'s step-1 reset (CR-01)'
      ).to.equal(true);
    });

    // The fresh-clone contract is interpolation-level: not a single
    // ${VAR:?...} required guard may remain anywhere in the demo file - any
    // one of them kills every compose command when the variable is unset.
    // Comment lines are excluded: prose mentioning the guard (like the file
    // header explaining why the demo file dropped it) never reaches the
    // interpolator.
    const effectiveLines = content
      .split('\n')
      .filter(line => !/^[ \t]*#/.test(line))
      .join('\n');
    expect(
      /\$\{[^}]+:\?/.test(effectiveLines),
      'docker-compose.demo.yml still carries a ${VAR:?} required-variable guard - with the variable unset, compose interpolation fails before anything runs (CR-01)'
    ).to.equal(false);
  });

  it('keeps the hard ${VAR:?required} guards for SESSION_SECRET and CRYPTO_SECRET in the production compose files', function() {
    // The demo-only `:-` loosening must not leak: real deployments must not
    // boot on placeholder secrets, so the production templates keep the
    // guards the demo file deliberately dropped.
    PRODUCTION_COMPOSE_FILES.forEach(file => {
      const content = fs.readFileSync(path.join(root, file), 'utf8');

      ['SESSION_SECRET', 'CRYPTO_SECRET'].forEach(name => {
        expect(
          hasRequiredGuard(content, name),
          file + ' must keep the ${' + name + ':?...} required-variable guard - a real deployment booting on placeholder secrets is the failure the guard exists for'
        ).to.equal(true);
      });
    });
  });

  it('defaults the host port to 3001 via DEMO_PORT (demo coexists with the install-check stand on 3000)', function() {
    const content = read();

    // Quoted or unquoted mapping both accepted; the load-bearing part is
    // the ${DEMO_PORT:-3001} default and the 3000 container side
    // the runtime image listens on.
    expect(
      content,
      'the ports mapping must default to ${DEMO_PORT:-3001}:3000'
    ).to.match(/^[ \t]*-?[ \t]*"\$\{DEMO_PORT:-3001\}:3000"[ \t]*$/m);
  });

  it('passes every brand env var through with an EMPTY default (default brand renders)', function() {
    const content = read();

    const missing = BRAND_VARS.filter(name => !hasEmptyDefault(content, name));
    expect(
      missing,
      'these brand vars lost the ${VAR:-} empty-default passthrough - a frozen literal would freeze the demo brand, an absent entry would break the passthrough'
    ).to.deep.equal([]);
  });

  it('TEETH: removing the image line or a secret guard from a fabricated copy fails the corresponding predicate', function() {
    const content = read();

    // Synthetic negative control (never mutating the real file): each
    // mutation is applied to an in-memory copy, and the predicate that the
    // contract spec relies on must flip to false - proving the specs above
    // are not vacuously green.

    const withoutImageLine = content.replace(
      new RegExp('^[ \t]*' + escapeRegexp(IMAGE_LINE) + '[ \t]*\n', 'm'),
      ''
    );
    expect(
      withoutImageLine,
      'sanity check: removing the image line must change the fabricated copy'
    ).to.not.equal(content);
    expect(
      hasExactLine(withoutImageLine, IMAGE_LINE),
      'the image-line pin has no teeth: a copy without the lever line still passes'
    ).to.equal(false);

    // The exact CR-01 regression: re-tightening the demo file to the
    // template's :? guard must fail the demo-default pin above.
    const reGuarded = content.replace(
      new RegExp('^[ \\t]*SESSION_SECRET:[ \\t]*\\$\\{SESSION_SECRET:-demo-[^}]*not-for-production\\}[ \\t]*$', 'm'),
      '      SESSION_SECRET: ${SESSION_SECRET:?SESSION_SECRET is required}'
    );
    expect(
      reGuarded,
      'sanity check: replacing the SESSION_SECRET demo default must change the fabricated copy'
    ).to.not.equal(content);
    expect(
      hasDemoSecretDefault(reGuarded, 'SESSION_SECRET'),
      'the demo-secret-default pin has no teeth: a copy re-tightened to the :? guard (the exact CR-01 fresh-clone breaker) still passes'
    ).to.equal(false);
  });

});
