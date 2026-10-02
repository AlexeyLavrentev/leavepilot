'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const {spawn} = require('node:child_process');
const path = require('node:path');
const EditionRegistry = require('../../lib/edition/registry');
const {startRuntime} = require('../../lib/runtime_startup');
const {createShutdownCoordinator} = require('../../lib/runtime_shutdown');
const scheduler = require('../../lib/scheduler/leave_start_reminders');
const taskLock = require('../../lib/scheduler/task_lock');
const reminderScheduler = require('../../lib/model/leave/reminder_scheduler');

describe('Runtime resource drain', function() {
  it('drains a real session save and active scheduler lock before SQL', async function() {
    const child = spawn(process.execPath, [path.join(__dirname, '../fixtures/runtime/shutdown_case.js'), 'delayed-job'], {
      cwd: path.join(__dirname, '../..'), env: {...process.env, NODE_ENV: 'test'},
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const events = [];
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on('message', message => events.push(message));
    const waitFor = async event => {
      for (let i = 0; i < 150; i += 1) {
        const found = events.find(message => message.event === event);
        if (found) { return found; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`missing ${event}: ${stderr}`);
    };
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 1800);
    try {
      const {port} = await waitFor('ready');
      await waitFor('job-pending');
      const response = fetch(`http://127.0.0.1:${port}/write`);
      await waitFor('save-pending');
      child.kill('SIGTERM');
      await waitFor('listener-closing');
      assert.equal(events.some(item => item.event === 'store-close'), false);
      child.send({event: 'release-save'});
      assert.equal((await response).status, 200);
      await waitFor('save-complete');
      assert.equal(events.some(item => item.event === 'sql-close'), false);
      child.send({event: 'release-job'});
      const code = await new Promise(resolve => child.once('close', resolve));
      assert.equal(code, 0, stderr);
      const order = events.map(item => item.event);
      assert.ok(order.indexOf('save-complete') < order.indexOf('store-close'), order.join(','));
      assert.ok(order.indexOf('lock-release') < order.indexOf('sql-close'), order.join(','));
      assert.ok(order.indexOf('store-close') < order.indexOf('sql-close'), order.join(','));
      assert.equal(events.find(item => item.event === 'sql-close').persisted, 1);
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
    }
  });

  it('waits for an active Community job and its lock release without rescheduling', async function() {
    const oldFlag = process.env.LEAVE_REMINDER_SCHEDULER_ENABLED;
    const oldFeature = process.env.FEATURE_LEAVE_START_REMINDERS;
    const oldSetTimeout = global.setTimeout;
    const oldAcquire = taskLock.tryAcquireTaskLock;
    const oldRelease = taskLock.releaseTaskLock;
    const oldSend = reminderScheduler.sendLeaveStartReminders;
    const callbacks = [];
    const events = [];
    let releaseJob;
    try {
      process.env.LEAVE_REMINDER_SCHEDULER_ENABLED = 'true';
      delete process.env.FEATURE_LEAVE_START_REMINDERS;
      global.setTimeout = callback => { callbacks.push(callback); return {unref() {}}; };
      taskLock.tryAcquireTaskLock = async () => ({acquired: true, lock: {}, lockedBy: 'owner'});
      reminderScheduler.sendLeaveStartReminders = () => new Promise(resolve => { releaseJob = () => resolve([]); });
      taskLock.releaseTaskLock = async () => { events.push('release'); };
      const handle = scheduler.startLeaveReminderScheduler({models: {}, logger: {log() {}, error() {}}});
      assert.equal(callbacks.length, 1);
      const running = callbacks[0]();
      await new Promise(resolve => setImmediate(resolve));
      let stopped = false;
      const stopping = Promise.resolve(handle.stop()).then(() => { stopped = true; });
      await Promise.resolve();
      assert.equal(stopped, false);
      releaseJob();
      await Promise.all([running, stopping]);
      assert.deepEqual(events, ['release']);
      assert.equal(callbacks.length, 1);
      await handle.stop();
      assert.equal(callbacks.length, 1);
    } finally {
      global.setTimeout = oldSetTimeout;
      taskLock.tryAcquireTaskLock = oldAcquire;
      taskLock.releaseTaskLock = oldRelease;
      reminderScheduler.sendLeaveStartReminders = oldSend;
      if (oldFlag === undefined) { delete process.env.LEAVE_REMINDER_SCHEDULER_ENABLED; }
      else { process.env.LEAVE_REMINDER_SCHEDULER_ENABLED = oldFlag; }
      if (oldFeature === undefined) { delete process.env.FEATURE_LEAVE_START_REMINDERS; }
      else { process.env.FEATURE_LEAVE_START_REMINDERS = oldFeature; }
    }
  });

  it('retains earlier scheduler handles when a later edition scheduler throws', function() {
    const registry = new EditionRegistry();
    const handle = {stop() {}};
    registry.registerScheduler({name: 'community', start: () => handle});
    registry.registerScheduler({name: 'premium', start: () => { throw new Error('premium failed'); }});
    assert.throws(() => registry.startSchedulers({}), error => {
      assert.equal(error.message, 'premium failed');
      assert.deepEqual(error.startedSchedulers, [{name: 'community', handle}]);
      return true;
    });
  });

  it('stops acquired schedulers before SQL after partial startup failure', async function() {
    const events = [];
    const handle = {stop: async () => { events.push('stop'); }};
    const lifecycle = {onStateChange: () => () => {}, initialize: async () => {}, close: async () => { events.push('store'); }};
    const app = {set() {}, get: name => ({db_model: {
      connect: async () => {}, sequelize: {close: async () => { events.push('sql'); }},
    }, session_middleware: {sessionLifecycle: lifecycle}})[name]};
    const server = new EventEmitter();
    server.close = callback => { events.push('http'); callback(); };
    const runtime = startRuntime({loadApp: () => app, listen: async () => server,
      startSchedulers: () => { const error = new Error('later scheduler'); error.startedSchedulers = [{name: 'first', handle}]; throw error; },
      installHandlers: () => {}, exit: code => { events.push(`exit:${code}`); }});
    await runtime.start();
    assert.deepEqual(events, ['http', 'stop', 'store', 'sql', 'exit:1']);
  });

  for (const shape of ['missing', 'sync', 'async', 'reject', 'hang']) {
    it(`handles ${shape} Premium stop within the shared deadline`, async function() {
      const events = [];
      const stop = {
        missing: undefined,
        sync: () => { events.push('stop'); },
        async: async () => { await new Promise(resolve => setTimeout(resolve, 5)); events.push('stop'); },
        reject: async () => { throw new Error('stop failed'); },
        hang: () => new Promise(() => {}),
      }[shape];
      const shutdown = createShutdownCoordinator({
        schedulers: [{name: 'premium', handle: stop ? {stop} : undefined}],
        db: {close: () => { events.push('sql'); }},
        timeoutMs: 60, exit: code => { events.push(`exit:${code}`); },
      });
      await shutdown('sigterm', null, 0);
      assert.equal(events.at(-1), `exit:${['reject', 'hang'].includes(shape) ? 1 : 0}`);
      assert.ok(events.includes('sql'));
      if (shape === 'async') { assert.ok(events.indexOf('stop') < events.indexOf('sql')); }
    });
  }

  it('closes an unused cache without creating Redis, then closes a used client once', async function() {
    const redis = require('redis');
    const config = require('../../lib/config');
    const originalSessionStore = config.get('sessionStore');
    const cachePath = require.resolve('../../lib/cache/team_view_cache');
    const originalCreate = redis.createClient;
    let creates = 0;
    let closes = 0;
    let destroys = 0;
    try {
      // The cache reads sessionStore through nconf at lazy-init time, so the
      // selection is driven through the same config seam the worker preloads
      // use — never a direct config/app.json mutation.
      config.set('sessionStore', {
        useRedis: true,
        redisConnectionConfiguration: {host: '127.0.0.1', port: 6379},
      });
      redis.createClient = () => {
        creates += 1;
        return {on() {}, connect: async () => {}, close: async () => { closes += 1; }, destroy() { destroys += 1; }};
      };
      delete require.cache[cachePath];
      const unused = require('../../lib/cache/team_view_cache');
      await unused.close();
      assert.equal(creates, 0);
      delete require.cache[cachePath];
      const used = require('../../lib/cache/team_view_cache');
      await used.getHtml('sample');
      assert.equal(creates, 1);
      await Promise.all([used.close(), used.close()]);
      assert.equal(closes, 1);
      used.forceClose();
      used.forceClose();
      assert.equal(destroys, 1);
    } finally {
      redis.createClient = originalCreate;
      config.set('sessionStore', originalSessionStore);
      delete require.cache[cachePath];
    }
  });
});
