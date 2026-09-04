'use strict';

var expect = require('chai').expect;
var fs = require('fs');
var os = require('os');
var path = require('path');
var spawn = require('child_process').spawn;

var skipHonesty = require('../lib/skip_honesty');

// The reporter is proven the only way its job can be proven: from outside
// the process, by driving a child mocha whose tests retry and skip for real
// and reading back the sidecar the runner merges. Nothing here re-implements
// the reporter's internals - the child uses the actual --reporter wiring
// bin/test.js uses.
var ROOT = path.join(__dirname, '..', '..');
var MOCHA = path.join('node_modules', 'mocha', 'bin', 'mocha');
var REPORTER = path.join('t', 'lib', 'flake_reporter.js');
var FLAKY_FIXTURE = path.join('t', 'fixtures', 'flake_reporter', 'flaky_fixture.js');
var SKIPPING_FIXTURE = path.join('t', 'fixtures', 'flake_reporter', 'skipping_fixture.js');

var runReporterMocha = function(sidecarPath) {
  return new Promise(function(resolve) {
    var output = '';
    var child = spawn(
      process.execPath,
      [
        MOCHA,
        '--retries', '1',
        '--reporter', REPORTER,
        '--reporter-option', 'fallbackSpec=fixture-batch-identity',
        FLAKY_FIXTURE,
        SKIPPING_FIXTURE,
      ],
      {
        cwd: ROOT,
        env: Object.assign({}, process.env, { FLAKE_ARTIFACT_PATH: sidecarPath }),
      }
    );

    child.stdout.on('data', function(chunk) { output += chunk; });
    child.stderr.on('data', function(chunk) { output += chunk; });
    child.on('error', function(error) { resolve({ code: null, output: output + String(error) }); });
    child.on('exit', function(code) { resolve({ code: code, output: output }); });
  });
};

describe('flake reporter (t/lib/flake_reporter.js)', function() {
  var sidecarPath;

  beforeEach(function() {
    sidecarPath = path.join(os.tmpdir(), 'flake-reporter-spec-' + process.pid + '.json');
    try { fs.unlinkSync(sidecarPath); } catch (noPriorFile) { /* absent is the clean start */ }
  });

  afterEach(function() {
    try { fs.unlinkSync(sidecarPath); } catch (alreadyGone) { /* nothing to clean */ }
  });

  it('records a retried test with its title, spec file and attempt, and a self-skip as pending', function() {
    return runReporterMocha(sidecarPath).then(function(run) {
      expect(run.code, 'child mocha output:\n' + run.output).to.equal(0);

      var sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

      expect(sidecar.retries).to.have.lengthOf(1);
      expect(sidecar.retries[0].title).to.equal(
        'flake reporter fixture: fail once, pass on retry fails its first attempt and passes the second'
      );
      // mocha carries absolute spec paths; assert the path identity, not the
      // prefix of whichever machine ran the child.
      expect(sidecar.retries[0].spec.endsWith(FLAKY_FIXTURE)).to.equal(true);
      expect(sidecar.retries[0].attempt).to.equal(1);
      expect(sidecar.retries[0].error).to.contain('deliberate first-attempt failure');

      expect(sidecar.pending).to.have.lengthOf(1);
      expect(sidecar.pending[0].spec.endsWith(SKIPPING_FIXTURE)).to.equal(true);
      expect(sidecar.pending[0].title).to.contain('skips itself');
    });
  });

  it('never records process.env values, only titles, paths and error text (T-05-01)', function() {
    return runReporterMocha(sidecarPath).then(function() {
      var raw = fs.readFileSync(sidecarPath, 'utf8');
      expect(raw).to.not.contain(sidecarPath);
    });
  });
});

describe('skip honesty threshold (t/lib/skip_honesty.js, D-21)', function() {
  // Env snapshot/restore per the house pattern (t/unit/env_deprecation.js):
  // the enforcement gate and the process exit code both belong to whoever
  // loaded this spec, so they go back exactly as they were found.
  var ENV_KEY = 'TEST_ENFORCE_SKIP_HONESTY';
  var CANONICAL_ENV_KEY = 'TEST_CANONICAL_VERIFY';
  var originalEnvValue;
  var originalCanonicalEnvValue;
  var originalExitCode;

  beforeEach(function() {
    originalEnvValue = process.env[ENV_KEY];
    originalCanonicalEnvValue = process.env[CANONICAL_ENV_KEY];
    delete process.env[ENV_KEY];
    delete process.env[CANONICAL_ENV_KEY];
    originalExitCode = process.exitCode;
  });

  afterEach(function() {
    if (typeof originalEnvValue === 'undefined') {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnvValue;
    }
    if (typeof originalCanonicalEnvValue === 'undefined') {
      delete process.env[CANONICAL_ENV_KEY];
    } else {
      process.env[CANONICAL_ENV_KEY] = originalCanonicalEnvValue;
    }
    process.exitCode = originalExitCode;
  });

  it('MAX_ALLOWED_SKIPPED_SPECS is a named constant equal to 4, and sitting at the threshold is no breach', function() {
    expect(skipHonesty.MAX_ALLOWED_SKIPPED_SPECS).to.equal(4);

    var atThreshold = skipHonesty.evaluateSkipHonesty(['a.js', 'b.js', 'c.js', 'd.js']);
    expect(atThreshold.distinct).to.have.lengthOf(4);
    expect(atThreshold.breach).to.equal(false);
    expect(atThreshold.enforce).to.equal(false);
  });

  it('counts distinct spec files, not pending tests', function() {
    var evaluation = skipHonesty.evaluateSkipHonesty([
      'a.js', 'a.js', 'a.js', null, 'b.js',
    ]);

    expect(evaluation.distinct).to.deep.equal(['a.js', 'b.js']);
    expect(evaluation.breach).to.equal(false);
  });

  it('breach with TEST_ENFORCE_SKIP_HONESTY set is a failure (carrier acts on it)', function() {
    process.env[ENV_KEY] = 'true';

    var evaluation = skipHonesty.reportSkipHonesty(['a.js', 'b.js', 'c.js', 'd.js', 'e.js']);

    expect(evaluation.breach).to.equal(true);
    expect(evaluation.enforce).to.equal(true);
  });

  it('breach with the env unset warns only - the exit code is the caller\'s to keep', function() {
    var evaluation = skipHonesty.reportSkipHonesty(['a.js', 'b.js', 'c.js', 'd.js', 'e.js']);

    expect(evaluation.breach).to.equal(true);
    expect(evaluation.enforce).to.equal(false);
    // Not this module's decision: the runner keeps process.exitCode as it
    // was (mocha's carrier throws only when enforcement is on).
    expect(process.exitCode).to.equal(originalExitCode);
  });

  it('no breach, no verdict either way', function() {
    process.env[ENV_KEY] = 'true';

    var evaluation = skipHonesty.reportSkipHonesty(['a.js']);

    expect(evaluation.breach).to.equal(false);
    expect(evaluation.enforce).to.equal(false);
  });
});
