'use strict';

/*
  BRAND-03 upgrade-path test.

  An existing deployment configured with TIMEOFF_* (the deprecated generation-1
  env names) must boot clean after the rename to LEAVEPILOT_*: exit 0, exactly
  one deprecation warning carrying every old→new pair, no env VALUE leaked into
  the warning, no config file mutated, and the same outcome on a second boot.

  The proof is a REAL boot, not a unit call: a fresh subprocess whose env is an
  owner-provided anonymized dump of a working deployment (the fixture from plan
  02-03 Task 1). The fixture is the one artifact the agent cannot fabricate — a
  synthetic env would prove nothing about real deployments — so when it is
  absent the suite SKIPS (honestly, with a clear owner-action message) rather
  than failing CI on a pending owner action.

  Boot scope: require('./lib/config') is the exact site of the boot deprecation
  emit (config.js:74 envResolver.reportDeprecations(process.env)), and
  require('./lib/branding').get() proves the brand name resolves. The full
  app/DB/HTTP stack is deliberately NOT loaded — the deprecation warning lives
  in the config boot path, which is the load-bearing slice for BRAND-03.
*/

var expect = require('chai').expect;
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var childProcess = require('child_process');

var repoRoot = path.join(__dirname, '..', '..');
var fixturePath = path.join(repoRoot, 't', 'fixtures', 'brand_upgrade_env.json');
var configPath = path.join(repoRoot, 'config', 'app.json');
var RESULT_MARKER = '__BRAND_UPGRADE_RESULT__';

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// Boot the config+branding path in a FRESH subprocess whose env is built from
// the fixture, so the boot is a faithful proxy for the real upgrade: an
// existing TIMEOFF_* deployment booting after the rename. console.warn is
// captured into the structured result so the parent can assert on it. Returns
// { status, result } where status is the subprocess exit code and result is the
// parsed JSON the subprocess wrote to stdout (null if absent/unparseable).
function bootUpgradeEnv(env) {
  // The script is built as a string and run with -e so each boot is an isolated
  // process — the env_resolver module-level warned flag resets per boot, which
  // is what makes the "exactly one warn per boot" and "deterministic on repeat"
  // assertions meaningful.
  var script = [
    '(function () {',
    "  'use strict';",
    '  var warns = [];',
    '  var origWarn = console.warn;',
    '  console.warn = function () {',
    '    warns.push(Array.prototype.slice.call(arguments).join(" "));',
    '  };',
    '  try {',
    "    require('./lib/config');",
    "    var branding = require('./lib/branding');",
    '    var name = branding.get() && branding.get().name;',
    '    console.warn = origWarn;',
    "    process.stdout.write(" + JSON.stringify(RESULT_MARKER) + " + JSON.stringify({ ok: true, name: name, warns: warns }));",
    '    process.exit(0);',
    '  } catch (err) {',
    '    console.warn = origWarn;',
    "    process.stdout.write(" + JSON.stringify(RESULT_MARKER) + " + JSON.stringify({ ok: false, error: String((err && err.message) || err), warns: warns }));",
    '    process.exit(1);',
    '  }',
    '})();',
  ].join('\n');

  try {
    var stdout = childProcess.execFileSync(process.execPath, ['-e', script], {
      cwd: repoRoot,
      env: env,
      encoding: 'utf8',
    });
    return { status: 0, stdout: stdout };
  } catch (err) {
    // execFileSync throws on a non-zero exit; the subprocess writes its
    // structured result to stdout before exiting, which execFileSync captures
    // on err.stdout.
    return { status: err.status, stdout: String(err.stdout || '') };
  }
}

function parseResult(stdout) {
  var markerAt = stdout.indexOf(RESULT_MARKER);
  if (markerAt === -1) {
    return null;
  }
  try {
    return JSON.parse(stdout.slice(markerAt + RESULT_MARKER.length));
  } catch (e) {
    return null;
  }
}

describe('BRAND-03 upgrade path: an existing TIMEOFF_* deployment boots clean', function() {

  var fixture;
  var bootEnv;

  before(function() {
    // The owner-provided anonymized fixture is the precondition for this whole
    // suite (plan 02-03 Task 1 gate). When it is absent, skip every spec
    // honestly rather than fail — the owner action is explicit, the test is
    // honest about its precondition.
    if (!fs.existsSync(fixturePath)) {
      this.skip('BRAND-03 fixture not provided by owner — t/fixtures/brand_upgrade_env.json absent. See plan 02-03 Task 1 user_setup; skipping, not failing.');
    }

    fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    // Clean base: do NOT inherit process.env. The test runner's own env could
    // carry TIMEOFF_*/LEAVEPILOT_* keys that would pollute the deprecation
    // count; the upgrade boot must be exercised against EXACTLY the fixture's
    // TIMEOFF_* names (the deprecated-alias path BRAND-03 exists to prove).
    bootEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    };
    Object.keys(fixture.env).forEach(function(key) {
      bootEnv[key] = fixture.env[key];
    });

    // The fixture anonymized away SESSION_SECRET and CRYPTO_SECRET — they are
    // secrets — but NODE_ENV=production makes lib/config hard-fail on missing
    // secrets (config.js:42-48) BEFORE reaching the deprecation emit. Restore
    // dummy values: test scaffolding that stands in for the secrets the real
    // production deployment has, NOT fabricated owner data. The dummy values
    // never enter the deprecation warning (only TIMEOFF_* NAMES do).
    if (fixture.env.NODE_ENV === 'production' || fixture.env.NODE_ENV === 'staging') {
      bootEnv.SESSION_SECRET = 'brand-upgrade-test-session-secret';
      bootEnv.CRYPTO_SECRET = 'brand-upgrade-test-crypto-secret';
    }
  });

  it('boots the config+branding path with exit 0', function() {
    var run = bootUpgradeEnv(bootEnv);
    var result = parseResult(run.stdout);
    expect(run.status, 'subprocess exited non-zero; result=' + JSON.stringify(result) + '; raw=' + run.stdout)
      .to.equal(0);
    expect(result, 'no structured result on stdout; raw=' + run.stdout).to.not.equal(null);
    expect(result.ok, 'boot threw: ' + (result && result.error)).to.equal(true);
    // The brand name resolves through the branding layer (default LeavePilot),
    // proving the boot completed past config into branding — the whole config
    // boot sequence survived a TIMEOFF_* env.
    expect(result.name, 'branding.get().name did not resolve').to.be.a('string');
  });

  it('emits exactly one deprecation warning carrying every old→new pair', function() {
    var run = bootUpgradeEnv(bootEnv);
    expect(run.status).to.equal(0);
    var result = parseResult(run.stdout);

    // Exactly one boot warn — reportSecurityPosture does not fire for this
    // fixture (no TRUST_PROXY), so the env_resolver deprecation is the sole
    // boot warning. A second boot warn would mean the upgrade path changed.
    expect(result.warns.length, 'expected exactly one boot warn; got=' + JSON.stringify(result.warns))
      .to.equal(1);

    var warn = result.warns[0];
    expect(warn, 'the boot warn is not the env_resolver deprecation line').to.match(/env_resolver: deprecated TIMEOFF_\*/);

    // The number of old→new pairs must equal expectedDeprecatedCount — the
    // fixture records how many TIMEOFF_* names its env carries, and the warning
    // carries exactly that many pairs (idempotency + count edge).
    var pairCount = (warn.match(/→/g) || []).length;
    expect(pairCount, 'deprecation warning carries the wrong number of old→new pairs: ' + warn)
      .to.equal(fixture.expectedDeprecatedCount);

    // Every fixture TIMEOFF_* key and its LEAVEPILOT_* mapping appears BY NAME.
    Object.keys(fixture.env).forEach(function(key) {
      if (key.indexOf('TIMEOFF_') === 0) {
        expect(warn, 'deprecation warning omits the deprecated name ' + key).to.contain(key);
        expect(warn, 'deprecation warning omits the canonical mapping for ' + key)
          .to.contain('LEAVEPILOT_' + key.slice('TIMEOFF_'.length));
      }
    });
  });

  it('does not leak any fixture env value into the warning (secret-leakage control)', function() {
    var run = bootUpgradeEnv(bootEnv);
    expect(run.status).to.equal(0);
    var result = parseResult(run.stdout);
    expect(result.warns.length).to.equal(1);
    var warn = result.warns[0];

    // No NON-EMPTY fixture value may appear — the warning carries NAMES + the
    // old→new mapping only, never VALUES (ASVS L1, threat T-02-03b). This is
    // the secret-leakage control exercised end-to-end on a real boot. Empty
    // values are skipped: an empty string is trivially "contained" in any line.
    Object.keys(fixture.env).forEach(function(key) {
      var value = fixture.env[key];
      if (value !== '' && value !== null && typeof value !== 'undefined') {
        expect(warn, 'the boot warning leaked the fixture value of ' + key + ' (' + value + ')')
          .to.not.contain(value);
      }
    });
  });

  it('leaves config/app.json byte-unchanged by the upgrade boot', function() {
    var before = sha256(configPath);
    var run = bootUpgradeEnv(bootEnv);
    expect(run.status).to.equal(0);
    var after = sha256(configPath);
    // The upgrade path edits no config file — an existing deployment boots
    // after upgrade with no config edit ("без правки конфигурации"). config.js
    // only nconf.set()s in memory, never writes app.json to disk.
    expect(after, 'the upgrade boot mutated config/app.json — the upgrade path must edit no config file')
      .to.equal(before);
  });

  it('boots deterministically on a second run (idempotency edge)', function() {
    var first = bootUpgradeEnv(bootEnv);
    var second = bootUpgradeEnv(bootEnv);
    expect(first.status, 'first boot exited non-zero').to.equal(0);
    expect(second.status, 'second boot exited non-zero').to.equal(0);

    var r1 = parseResult(first.stdout);
    var r2 = parseResult(second.stdout);
    expect(r1.warns, 'second boot produced a different warning set than the first — non-deterministic')
      .to.deep.equal(r2.warns);
    expect(r1.name, 'second boot resolved a different brand name than the first — non-deterministic')
      .to.equal(r2.name);
  });
});
