'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawnInGroup, terminateGroup} = require('../../bin/lib/spawn_group');

const root = path.join(__dirname, '../..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') { return false; } throw error; }
};
const until = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) { await wait(25); }
  return Boolean(predicate());
};

function run(args, env, deadlineMs) {
  const child = spawnInGroup(process.execPath, args, {
    cwd: root, env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let output = '';
  let result;
  child.on('message', message => messages.push(message));
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  child.once('exit', (code, signal) => { result = {code, signal}; });
  const watchdog = setTimeout(() => { if (!result) { child.kill('SIGKILL'); } }, deadlineMs);
  child.once('exit', () => clearTimeout(watchdog));
  return {child, messages, get output() { return output.slice(-3000); }, get result() { return result; }};
}

describe('cluster tracer, primary ownership and signal forwarding', function() {
  this.timeout(15000);
  it('serves migrated SQLite sessions from two workers and drains both signals without survivors', async function() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-cluster-'));
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const env = {
      NODE_ENV: 'development', DB_DIALECT: 'sqlite', DB_STORAGE: path.join(directory, 'app.sqlite'),
      DB_LOGGING: 'false', PORT: String(port), HOST: '127.0.0.1',
      SESSION_SECRET: 'test-only-session-secret', CRYPTO_SECRET: 'test-only-crypto-secret',
      SILENCE_HTTP_LOGS: 'true', DISABLE_NOTIFICATIONS_POLLING: 'true',
    };
    let parent;
    let workerPids = [];
    try {
      const migration = run(['bin/db_update.js'], env, 12000);
      assert.equal(await until(() => migration.result, 12000), true, migration.output);
      assert.equal(migration.result.code, 0, migration.output);
      for (const signal of ['SIGTERM', 'SIGINT']) {
        parent = run(['t/fixtures/runtime/cluster_case.js'], env, 13000);
        assert.equal(await until(() => parent.messages.filter(message => message.type === 'cluster-ready').length === 2 || parent.result, 9000), true, parent.output);
        assert.equal(parent.result, undefined, parent.output);
        workerPids = parent.messages.filter(message => message.type === 'cluster-ready').map(message => message.pid);
        assert.equal(new Set(workerPids).size, 2);
        const served = new Set();
        for (let i = 0; i < 30 && served.size < 2; i += 1) {
          const response = await fetch(`http://127.0.0.1:${port}/login/`, {headers: {connection: 'close'}});
          assert.equal(response.status, 200);
          assert.match(response.headers.get('set-cookie') || '', /connect\.sid=/);
          served.add(Number(response.headers.get('x-test-worker-pid')));
          await response.arrayBuffer();
        }
        assert.deepEqual([...served].sort(), [...workerPids].sort());
        parent.child.kill(signal);
        assert.equal(await until(() => parent.result, 12000), true, parent.output);
        assert.equal(parent.result.code, 0, parent.output);
        assert.equal(await until(() => workerPids.every(pid => !alive(pid)), 1000), true, parent.output);
        parent = null;
        workerPids = [];
      }
    } finally {
      if (parent) { await terminateGroup(parent.child, {graceMs: 200}); }
      for (const pid of workerPids) { if (alive(pid)) { process.kill(pid, 'SIGKILL'); } }
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });
});
