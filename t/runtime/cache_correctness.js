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

  it('family matrix: every HTTP-representative mutation family invalidates cross-worker before any TTL expiry', async function() {
    this.timeout(360000);
    const result = await caseResult(['--case', 'families'], 330000);
    assert.equal(result.case, 'families');
    assert.equal(result.workers, 2);
    assert.equal(result.all_families_passed, true);

    // The frozen 17-family list is the CACHE-03 completeness criterion; the
    // 03-05 stage registration depends on this exact ordering and count.
    const expectedFamilies = [
      'leave_approve',
      'leave_reject',
      'leave_cancel',
      'leave_revoke_request',
      'leave_bulk_approve',
      'user_create',
      'user_update',
      'department_create',
      'department_update_supervisor',
      'leave_type_create',
      'bank_holiday_create',
      'bank_holiday_preset_import',
      'work_calendar_create',
      'schedule_save',
      'company_settings_save',
      'csv_import',
      'user_delete',
    ];
    assert.deepEqual(result.families.map(family => family.name), expectedFamilies);

    for (const family of result.families) {
      assert.equal(family.version_advanced, true, `${family.name}: version did not advance`);
      assert.ok(family.version_after > family.version_before,
        `${family.name}: version ${family.version_before} -> ${family.version_after}`);
      assert.equal(family.marker_visible, true, `${family.name}: marker (${family.direction}) not visible`);
      assert.ok(family.elapsed_ms < 10000, `${family.name}: cycle took ${family.elapsed_ms}ms; TTL could have contributed`);
      assert.ok(family.mutation_worker_pid, `${family.name}: no mutation worker pid`);
      assert.ok(family.read_worker_pid, `${family.name}: no read worker pid`);
      assert.notEqual(family.mutation_worker_pid, family.read_worker_pid,
        `${family.name}: the read must be served by a different worker than the mutation`);
      assert.ok(['appears', 'disappears'].includes(family.direction), `${family.name}: unknown direction`);
    }
  });
});
