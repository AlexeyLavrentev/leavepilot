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

  it('bypass contour: a clustered deployment without shared coordination recomputes every read and never caches (D-01)', async function() {
    this.timeout(180000);
    const result = await caseResult(['--case', 'bypass-no-coordination'], 150000);
    assert.equal(result.case, 'bypass-no-coordination');
    assert.equal(result.workers, 2);
    assert.equal(result.distinct_worker_pids, 2);
    assert.equal(result.reads_ok_both_workers, true);
    // The stale-memory regression trap: the mutation through worker B is
    // visible in the twice-warmed worker A's very next read.
    assert.equal(result.mutation_visible_through_warmed_worker, true);
    assert.notEqual(result.mutation_worker_pid, result.read_worker_pid,
      'the mutation must be served by a different worker than the warmed reads');
    assert.equal(result.bypass_event_logged, true);
    assert.equal(result.teamview_keys_in_store, 0, 'nothing may be cached without shared coordination');
    assert.equal(result.signal_exit, 0);
  });

  it('outage contour: losing the shared store degrades to bypass recompute without exiting and resumes on recovery (D-05)', async function() {
    this.timeout(240000);
    const result = await caseResult(['--case', 'store-outage'], 210000);
    assert.equal(result.case, 'store-outage');
    assert.equal(result.workers, 2);
    assert.equal(result.cache_key_warmed_before_outage, true);
    // Bounded 200 responses with fresh recomputed content while the store is
    // gone; the process never exits and never restarts a worker.
    assert.equal(result.reads_ok_during_outage, true);
    assert.equal(result.mutation_visible_during_outage, true);
    assert.equal(result.worker_pids_unchanged, true);
    assert.equal(result.bypass_transition_logged, true);
    assert.equal(result.invalidation_failure_logged, true);
    // Recovery in the same process: caching resumes and the shared version
    // advanced at or beyond the number of mutations attempted during the
    // outage.
    assert.equal(result.resumed_caching, true);
    assert.equal(result.version_advanced, true);
    assert.equal(result.version_at_or_beyond_outage_mutations, true);
    assert.ok(result.version_after_recovery > result.version_before_outage,
      `version did not advance: ${result.version_before_outage} -> ${result.version_after_recovery}`);
    // A model-mutating CLI with hooks active under a Redis-configured
    // environment exits within its bounded lifetime (no dangling socket).
    assert.equal(result.cli_bounded_exit, true);
    assert.equal(result.signal_exit, 0);
  });
});
