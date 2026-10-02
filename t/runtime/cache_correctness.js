'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const {spawnInGroup, terminateTree} = require('../../bin/lib/spawn_group');

const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 't/fixtures/runtime/cache_case.js');
const setup = 'docker compose -p leavepilot-runtime-test -f t/fixtures/runtime/services.compose.yml up -d --wait --wait-timeout 60';
const testEnv = {
  TEST_SESSION_HOST: '127.0.0.1', TEST_REDIS_PORT: '16379',
  DB_HOST: '127.0.0.1', DB_PORT: '13306', DB_NAME: 'leavepilot_runtime_test',
  DB_USER: 'leavepilot_runtime_test', DB_PASSWORD: 'runtime_test_only',
};

function run(args, env, timeout = 15000) {
  return spawnSync(process.execPath, [fixture, ...args], {
    cwd: root, env: {...process.env, ...env}, encoding: 'utf8', timeout,
  });
}

async function caseResult(args, timeout = 90000) {
  const proc = spawnInGroup(process.execPath, [fixture, ...args], {
    cwd: root, env: {...process.env, ...testEnv}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [proc.stdout, proc.stderr]) {
    stream.on('data', chunk => { output = (output + chunk.toString()).slice(-6000); });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminateTree(proc, {graceMs: 100}).catch(() => {});
  }, timeout);
  try {
    const code = await new Promise((resolve, reject) => {
      proc.once('error', reject);
      proc.once('close', resolve);
    });
    assert.equal(timedOut, false, `Case exceeded ${timeout}ms: ${output}`);
    assert.equal(code, 0, output);
    return JSON.parse(output.trim().split('\n').at(-1));
  } finally {
    clearTimeout(timer);
    await terminateTree(proc, {graceMs: 100});
  }
}

describe('real cross-worker cache correctness', function() {
  it('cache tracer: reports an absent Redis endpoint as a failed prerequisite with setup guidance', function() {
    this.timeout(15000);
    const result = run(['--prerequisite', 'redis'], {...testEnv, TEST_REDIS_PORT: '1'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /docker compose -p leavepilot-runtime-test/);
  });

  it('cache tracer: a leave booked through one worker is visible to the other worker before any TTL expiry', async function() {
    this.timeout(120000);
    const result = await caseResult(['--case', 'shared']);
    assert.equal(result.case, 'shared');
    assert.equal(result.workers, 2);
    assert.equal(result.cacheKeyWarmed, true);
    assert.equal(result.versionAdvanced, true);
    assert.ok(result.versionAfter > result.versionBefore, `version did not advance: ${result.versionBefore} -> ${result.versionAfter}`);
    assert.equal(result.leaveVisibleAcrossWorkers, true);
    assert.ok(result.elapsedMs < 10000, `warm-to-read interval ${result.elapsedMs}ms is not inside the TTL window`);
    assert.equal(result.signalExit, 0);
  });
});
