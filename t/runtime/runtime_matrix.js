'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const {spawnInGroup, terminateTree} = require('../../bin/lib/spawn_group');

const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 't/fixtures/runtime/runtime_matrix_case.js');
const setup = 'docker compose -p leavepilot-runtime-test -f t/fixtures/runtime/services.compose.yml up -d --wait --wait-timeout 60';
const testEnv = {
  DB_HOST: '127.0.0.1', DB_PORT: '13306', DB_NAME: 'leavepilot_runtime_test',
  DB_USER: 'leavepilot_runtime_test', DB_PASSWORD: 'runtime_test_only',
  TEST_SESSION_HOST: '127.0.0.1', TEST_REDIS_PORT: '16379', TEST_ENGRAM_PORT: '16380',
};

function run(args, env, timeout = 15000) {
  return spawnSync(process.execPath, [fixture, ...args], {
    cwd: root, env: {...process.env, ...env}, encoding: 'utf8', timeout,
  });
}

async function caseResult(args, timeout = 14500) {
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

describe('real runtime matrix', function() {
  it('matrix tracer: requires all three isolated services before selected execution', function() {
    this.timeout(15000);
    const result = run(['--prerequisite'], testEnv);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\nSetup: ${setup}`);
    assert.match(result.stdout, /mysql.*redis.*engram/i);
  });

  it('matrix tracer: migrates and serves a real session before bounded direct shutdown', async function() {
    this.timeout(15000);
    const result = await caseResult(['--case', 'sqlite', 'sql', 'direct']);
    assert.equal(result.sessionWriteRead, true);
    assert.equal(result.loginLogout, true);
    assert.equal(result.signalExit, 0);
  });

  for (const dialect of ['sqlite', 'mysql']) {
    for (const backend of ['sql', 'redis', 'engram']) {
      for (const entrypoint of ['direct', 'cluster']) {
        if (dialect === 'sqlite' && backend === 'sql' && entrypoint === 'direct') { continue; }
        it(`migrates and serves ${dialect}/${backend}/${entrypoint} with a real session and bounded stop`, async function() {
          this.timeout(15000);
          const result = await caseResult(['--case', dialect, backend, entrypoint]);
          assert.deepEqual([result.dialect, result.backend, result.entrypoint], [dialect, backend, entrypoint]);
          assert.equal(result.migrated, true);
          assert.equal(result.sessionWriteRead, true);
          assert.equal(result.loginLogout, true);
          assert.equal(result.signalExit, 0);
        });
      }
    }
  }

  for (const [dialect, fault, entrypoint] of [
    ['sqlite', 'schema', 'direct'],
    ['mysql', 'schema', 'cluster'],
    ['mysql', 'credentials', 'direct'],
  ]) {
    it(`rejects ${dialect}/${fault}/${entrypoint} before serving HTTP`, async function() {
      this.timeout(15000);
      const result = await caseResult(['--fault', dialect, fault, entrypoint]);
      assert.equal(result.nonzero, true);
      assert.equal(result.listenerClosed, true);
    });
  }

  it('reports an absent selected endpoint as a failed prerequisite with setup guidance', function() {
    const result = run(['--prerequisite', 'redis'], {...testEnv, TEST_REDIS_PORT: '1'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /docker compose -p leavepilot-runtime-test/);
  });
});
