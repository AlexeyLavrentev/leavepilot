'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {spawnSync} = require('child_process');
const {expect} = require('chai');
const registry = require('../../../lib/verify/stages');

const root = path.join(__dirname, '..', '..', '..');
const timings = JSON.parse(fs.readFileSync(
  path.join(root, 't', 'fixtures', 'verify', 'runtime_timings.json'),
  'utf8'
));
const SETUP = 'docker compose -p leavepilot-runtime-test -f t/fixtures/runtime/services.compose.yml up -d --wait --wait-timeout 60';
const TEARDOWN = 'docker compose -p leavepilot-runtime-test -f t/fixtures/runtime/services.compose.yml down -v';
// Synthetic, fixture-owned inputs only: nothing here may depend on an
// operator secret or a production endpoint.
const RUNTIME_ENV = {
  DB_HOST: '127.0.0.1',
  DB_PORT: '13306',
  DB_NAME: 'leavepilot_runtime_test',
  DB_USER: 'leavepilot_runtime_test',
  DB_PASSWORD: 'runtime_test_only',
  TEST_SESSION_HOST: '127.0.0.1',
  TEST_REDIS_PORT: '16379',
  TEST_ENGRAM_PORT: '16380',
};
const readWorkflow = name => fs.readFileSync(
  path.join(root, '.github', 'workflows', name),
  'utf8'
);

describe('runtime lifecycle stages', () => {
  it('selects every real-service stage in one authoritative profile', () => {
    expect(registry.profile('ci-runtime').authoritative).to.equal(true);
    expect(registry.profile('ci-runtime').stageIds).to.deep.equal([
      'redis-session', 'engram-session', 'runtime-matrix', 'cache-correctness',
    ]);
    // The Phase 3 stage is additive: the Phase 2 runtime-matrix definition
    // (argv and dependencies) stays byte-unchanged.
    expect(registry.stage('runtime-matrix').dependencies)
      .to.deep.equal(['redis-session', 'engram-session']);
    expect(registry.stage('runtime-matrix').args).to.deep.equal([
      'node_modules/mocha/bin/mocha', 't/runtime/runtime_matrix.js',
      '--timeout', '15000', '--require', 't/lib/skip_honesty.js',
    ]);
    expect(registry.stage('cache-correctness').dependencies).to.deep.equal([]);
  });

  it('keeps fixed argv, prerequisite selections and synthetic test-only inputs', () => {
    const expectedArgs = {
      'redis-session': ['t/fixtures/runtime/runtime_matrix_case.js', '--session-suite', 'redis'],
      'engram-session': ['t/fixtures/runtime/runtime_matrix_case.js', '--session-suite', 'engram'],
      'runtime-matrix': [
        'node_modules/mocha/bin/mocha', 't/runtime/runtime_matrix.js',
        '--timeout', '15000', '--require', 't/lib/skip_honesty.js',
      ],
      'cache-correctness': ['t/fixtures/runtime/cache_case.js', '--suite'],
    };
    const expectedSelection = {
      'redis-session': 'redis',
      'engram-session': 'engram',
      'runtime-matrix': 'all',
      'cache-correctness': 'redis',
    };
    for (const id of Object.keys(expectedArgs)) {
      const stage = registry.stage(id);
      expect(stage.command, id).to.equal(process.execPath);
      expect(stage.args, id).to.deep.equal(expectedArgs[id]);
      expect(stage.resource, id).to.equal('runtime-services');
      expect(stage.prerequisite.command, id).to.equal(process.execPath);
      expect(stage.prerequisite.args, id).to.deep.equal([
        't/fixtures/runtime/runtime_matrix_case.js', '--prerequisite', expectedSelection[id],
      ]);
      expect(stage.prerequisite.setup, id).to.equal(SETUP);
      expect(stage.env, id).to.deep.include(RUNTIME_ENV);
      expect(Object.isFrozen(stage.env), id).to.equal(true);
    }
  });

  it('derives deadlines from retained successful measurements of the pinned sources', () => {
    expect(timings.schemaVersion).to.equal(1);
    expect(timings.margin).to.equal(2);
    // The cache-correctness budget pins every source the stage executes or
    // freezes: the case program, the mocha wrapper that shares its frozen
    // family-list contract, and the cache/invalidation production modules.
    for (const pinned of [
      't/fixtures/runtime/cache_case.js',
      't/runtime/cache_correctness.js',
      'lib/cache/team_view_cache.js',
      'lib/model/db/team_view_invalidation.js',
    ]) {
      expect(timings.sourceSha256[pinned], pinned).to.be.a('string').and.have.lengthOf(64);
    }
    for (const id of ['redis-session', 'engram-session', 'runtime-matrix', 'cache-correctness']) {
      const measured = timings.stages[id];
      expect(measured.samples, id).to.have.lengthOf.at.least(2);
      for (const sample of measured.samples) {
        expect(sample.exitCode, id).to.equal(0);
        expect(sample.durationMs, id).to.be.a('number').and.be.greaterThan(0);
        expect(sample.durationMs, id).to.be.lessThan(sample.parentBoundMs);
      }
      expect(measured.observedMaximumMs, id)
        .to.equal(Math.max(...measured.samples.map(sample => sample.durationMs)));
      expect(measured.deadlineMs, id).to.equal(measured.observedMaximumMs * timings.margin);
      expect(JSON.stringify(measured.argv.slice(1)), id)
        .to.equal(JSON.stringify(registry.stage(id).args));
      expect(registry.stage(id).deadlineMs, id).to.equal(measured.deadlineMs);
    }
    for (const [file, expected] of Object.entries(timings.sourceSha256)) {
      const actual = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(root, file)))
        .digest('hex');
      expect(actual, file).to.equal(expected);
    }
  });

  it('never provisions its own prerequisites', () => {
    for (const stage of registry.stages) {
      expect(String(stage.command)).to.not.match(/docker/i);
      if (stage.prerequisite) {
        expect(String(stage.prerequisite.command)).to.not.match(/docker/i);
        expect(stage.prerequisite.setup).to.be.a('string').and.not.equal('');
      }
    }
    const verifier = fs.readFileSync(path.join(root, 'bin', 'verify.js'), 'utf8');
    expect(verifier).to.not.match(/docker/i);
  });

  it('reports an unusable selected endpoint as a red prerequisite with the exact setup command', () => {
    // The fixture pins its dedicated ports, so a wrong port is rejected by
    // the input guard before any probe: the same red-with-guidance outcome
    // the committed matrix suite uses for an absent endpoint. A green or
    // skipped result here would hide a missing service.
    const result = spawnSync(process.execPath,
      ['t/fixtures/runtime/runtime_matrix_case.js', '--prerequisite', 'redis'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 9000,
        env: Object.assign({}, RUNTIME_ENV, {TEST_REDIS_PORT: '1'}),
      });
    expect(result.error).to.equal(undefined);
    expect(result.status).to.equal(1);
    expect(result.stderr).to.match(/missing-prerequisite|Dedicated TEST_REDIS_PORT required/);
    expect(result.stderr).to.include(SETUP);
    expect(result.stdout).to.not.include('ready');
  });

  it('reports an unusable cache-correctness endpoint as a red prerequisite with the exact setup command', () => {
    // Same red-with-guidance contract for the cache suite: the fixture pins
    // its dedicated port, so a wrong port is rejected by the input guard
    // before any probe. The stage must never provision its own services.
    const result = spawnSync(process.execPath,
      ['t/fixtures/runtime/cache_case.js', '--prerequisite', 'redis'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 9000,
        env: Object.assign({}, RUNTIME_ENV, {TEST_REDIS_PORT: '1'}),
      });
    expect(result.error).to.equal(undefined);
    expect(result.status).to.equal(1);
    expect(result.stderr).to.match(/missing-prerequisite|Dedicated TEST_REDIS_PORT required/);
    expect(result.stderr).to.include(SETUP);
    expect(result.stdout).to.not.include('ready');
  });

  describe('CI wiring', () => {
    it('runs the shared profile on job-owned disposable services', () => {
      const workflow = readWorkflow('core-ci.yml');
      expect(workflow).to.include('  runtime-lifecycle:');
      const job = workflow.slice(
        workflow.indexOf('  runtime-lifecycle:'),
        workflow.indexOf('  security:')
      );
      expect(job).to.include('node-version: 22');
      expect(job).to.include('npm ci');
      expect(job).to.include('CHROMEDRIVER_SKIP_DOWNLOAD');
      expect(job).to.include(SETUP);
      expect(job).to.include('node bin/verify.js --profile ci-runtime');
      expect(job).to.include('DB_HOST: 127.0.0.1');
      expect(job).to.include("DB_PORT: '13306'");
      expect(job).to.include('DB_NAME: leavepilot_runtime_test');
      expect(job).to.include('DB_USER: leavepilot_runtime_test');
      expect(job).to.include('DB_PASSWORD: runtime_test_only');
      expect(job).to.include('TEST_SESSION_HOST: 127.0.0.1');
      expect(job).to.include("TEST_REDIS_PORT: '16379'");
      expect(job).to.include("TEST_ENGRAM_PORT: '16380'");
      expect(job).to.match(/timeout-minutes: \d+/);
      expect(job).to.match(
        /if: always\(\)[\s\S]{0,400}path: \|\n +\.artifacts\/verify\/\n +!\.artifacts\/verify\/browser\/\*\*\n +if-no-files-found: error/
      );
      // Cleanup is unconditional and scoped to the dedicated project only.
      expect(job).to.match(new RegExp(
        `if: always\\(\\)[\\s\\S]*${TEARDOWN.replace(/[/.]/g, '\\$&')}`
      ));
      expect(job).to.not.match(/docker (rm|rmi|system) /);
    });

    it('preserves the existing MySQL dialect job and read-only permissions', () => {
      const workflow = readWorkflow('core-ci.yml');
      expect(workflow).to.include('contents: read');
      expect(workflow).to.include('  mysql-dialect:');
      expect(workflow).to.include('node bin/verify.js --profile ci-mysql');
      expect(workflow).to.include('mysql:8.0.45');
    });
  });

  describe('operator documentation', () => {
    const doc = () => fs.readFileSync(path.join(root, 'docs', 'runtime-lifecycle.md'), 'utf8');

    it('documents the exact disposable setup, inputs and cleanup', () => {
      const text = doc();
      for (const literal of [
        SETUP,
        TEARDOWN,
        'node bin/verify.js --profile ci-runtime',
        'DB_HOST=127.0.0.1',
        'DB_PORT=13306',
        'DB_NAME=leavepilot_runtime_test',
        'DB_USER=leavepilot_runtime_test',
        'DB_PASSWORD=runtime_test_only',
        'TEST_SESSION_HOST',
        'TEST_SESSION_PORT',
        'TEST_REDIS_PORT',
        'TEST_ENGRAM_PORT',
      ]) {
        expect(text, literal).to.include(literal);
      }
    });

    it('documents store selection, failure policy and current limits', () => {
      const text = doc();
      expect(text).to.include('16379');
      expect(text).to.include('16380');
      // Unready admission answer and unchanged cookie contract.
      expect(text).to.include('503');
      expect(text).to.include('connect.sid');
      // Honest boundaries: policy budgets pending final measurements and the
      // private Premium test limit.
      expect(text).to.match(/08/);
      expect(text).to.match(/Premium/);
    });
  });
});
