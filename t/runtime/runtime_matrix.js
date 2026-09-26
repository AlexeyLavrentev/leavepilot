'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 't/fixtures/runtime/runtime_matrix_case.js');
const setup = 'docker compose -p leavepilot-runtime-test -f t/fixtures/runtime/services.compose.yml up -d --wait --wait-timeout 60';

function run(args, env, timeout = 15000) {
  return spawnSync(process.execPath, [fixture, ...args], {
    cwd: root, env: {...process.env, ...env}, encoding: 'utf8', timeout,
  });
}

describe('real runtime matrix', function() {
  it('matrix tracer: requires all three isolated services before selected execution', function() {
    this.timeout(15000);
    const result = run(['--prerequisite'], {
      DB_HOST: '127.0.0.1', DB_PORT: '13306', DB_NAME: 'leavepilot_runtime_test',
      DB_USER: 'leavepilot_runtime_test', DB_PASSWORD: 'runtime_test_only',
      TEST_SESSION_HOST: '127.0.0.1', TEST_REDIS_PORT: '16379', TEST_ENGRAM_PORT: '16380',
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\nSetup: ${setup}`);
    assert.match(result.stdout, /mysql.*redis.*engram/i);
  });
});
