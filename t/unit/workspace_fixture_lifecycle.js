'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');

// Run actual suite hooks in a child: a lost rejection must not escape into Mocha.
// No application, browser, database, or real environment is mutated by the hooks.
async function inspect(filename, failAt, failCleanup) {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const {createRequire} = require('node:module');
  const localRequire = createRequire(filename);
  const failure = new Error('controlled setup failure');
  const cleanupFailure = new Error('controlled cleanup failure');
  const unhandled = [];
  process.on('unhandledRejection', error => unhandled.push(error.message));
  let step = 0;
  let nextId = 1;
  let released = 0;
  let quit = 0;
  let globalProcessQueries = 0;
  let tempDirectories = 0;
  let cleanupCalls = 0;
  const created = [];
  const destroyed = [];
  const hooks = {};
  async function operation(value) {
    step += 1;
    if (step === failAt) { throw failure; }
    return value;
  }
  const record = () => ({id: nextId++, companyId: 1,
    update() { return operation(this); }, reload() { return operation(this); }});
  const models = {Sequelize: {Op: {in: Symbol('in')}}};
  for (const name of ['Company', 'Department', 'User', 'LeaveType', 'Leave', 'ReminderSchedule', 'UserFeed']) {
    models[name] = {
      async create() {
        const value = await operation(record());
        created.push({name, id: value.id});
        return value;
      },
      findOne: () => operation(record()),
      destroy: async options => {
        const collectIds = value => value && typeof value === 'object'
          ? Reflect.ownKeys(value).flatMap(key => collectIds(value[key])) : [value];
        const ids = collectIds(options.where);
        if (!ids.length || ids.some(id => !Number.isInteger(id))) { throw new Error('unscoped cleanup'); }
        destroyed.push(...ids.map(id => ({name, id})));
        cleanupCalls += 1;
        if (failCleanup && cleanupCalls === 1) { throw cleanupFailure; }
      },
      hashify_password: () => 'synthetic',
      status_new: () => 1, status_approved: () => 2, leave_day_part_all: () => 1,
      promise_new_feed: () => operation({feed_token: 'synthetic'}),
    };
  }
  const driver = {quit: async () => { quit += 1; }};
  const request = {type() { return this; }, send() { return this; }, expect() { return operation({}); }};
  const fakeHttp = {
    ready: () => operation(), getApp: () => ({get: () => models}),
    agent: () => operation({post: () => request}), release: async () => { released += 1; },
  };
  const savedEnv = {BRAND_NAME: 'original-brand'};
  const context = vm.createContext({
    __dirname: require('node:path').dirname(filename),
    process: {env: savedEnv, stdout: {write() {}}},
    setTimeout, clearTimeout,
    require: name => {
      if (name === 'fs') { return {...fs, mkdirSync() {}, mkdtempSync: prefix => prefix + (++tempDirectories)}; }
      if (name === 'child_process') { return {spawnSync: () => { globalProcessQueries += 1; return {status: 0, stdout: '1\n'}; }}; }
      if (name.endsWith('/model/db')) { return models; }
      if (name.endsWith('/http_agent')) { return fakeHttp; }
      if (name.endsWith('/branding')) { return {__resetOemCacheForTests() {}}; }
      if (name.endsWith('/email')) { return function Email() {}; }
      if (name === '../../lib/config') { return {get_application_host: () => 'http://example.test/', get_execution_timeout: () => 1000}; }
      if (name.endsWith('/register_new_user')) { return () => operation({driver, email: 'synthetic@example.test'}); }
      if (name.endsWith('/add_new_user')) { return () => operation(); }
      if (name === '../../lib/open_page' || name === '../../lib/set_viewport') { return () => operation(); }
      return localRequire(name);
    },
    describe: (_title, fn) => fn.call({timeout() {}}), it() {},
    before: fn => { hooks.before = fn; }, after: fn => { hooks.after = fn; },
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, {filename});
  async function invoke(fn) {
    const outcomes = [];
    const done = error => outcomes.push(!error ? 'success' : error === failure ? 'setup-error'
      : error === cleanupFailure ? 'cleanup-error' : String(error));
    try {
      const result = fn.length ? fn(done) : fn();
      if (result && typeof result.then === 'function') { await result.then(() => done(), done); }
      else if (!fn.length) { done(); }
    } catch (error) { done(error); }
    await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
    return outcomes;
  }
  const setup = await invoke(hooks.before);
  const cleanup = await invoke(hooks.after);
  const maskLeaks = filename.endsWith('/oem_no_vendor_leak.js') ? vm.runInContext(
    `['<script id="timeoff-config"></script>', '<p>timeoff-config</p>', '<p title="timeoff-config">ok</p>', '<p data-id="timeoff-config">ok</p>'].map(value => brandLiteral.test(maskJsNamespace(value)))`, context) : null;
  process.stdout.write(JSON.stringify({setup, cleanup, unhandled, released, quit, created, destroyed,
    globalProcessQueries, tempDirectories, maskLeaks, brandName: savedEnv.BRAND_NAME}));
}

function run(filename, failAt, failCleanup = false) {
  const result = spawnSync(process.execPath, ['-e', `(${inspect})(${JSON.stringify(path.resolve(filename))}, ${failAt}, ${failCleanup}).catch(error => { console.error(error); process.exitCode = 1; });`], {
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe('workspace suite fixture lifecycle', function() {
  this.timeout(10000);
  it('does not exempt rendered OEM vendor text alongside the configuration script ID', function() {
    assert.deepEqual(run('t/unit/oem_no_vendor_leak.js', 1).maskLeaks, [false, true, true, true]);
  });
  for (const [file, steps] of [['reminder_schedules_api', 14], ['oem_no_vendor_leak', 6]]) {
    for (let step = 1; step <= steps; step += 1) {
      it(`${file}: releases shared HTTP and owned records after setup failure ${step}`, function() {
        const result = run(`t/unit/${file}.js`, step);
        assert.deepEqual(result.setup, ['setup-error']);
        assert.deepEqual(result.cleanup, ['success']);
        assert.deepEqual(result.unhandled, []);
        assert.equal(result.released, 1);
        assert.equal(result.brandName, 'original-brand');
        for (const item of result.created) {
          assert.ok(result.destroyed.some(value => value.name === item.name && value.id === item.id), JSON.stringify(item));
        }
      });
    }
    it(`${file}: continues cleanup and releases HTTP after one deletion fails`, function() {
      const result = run(`t/unit/${file}.js`, 0, true);
      assert.deepEqual(result.setup, ['success']);
      assert.deepEqual(result.cleanup, ['cleanup-error']);
      assert.equal(result.released, 1);
      assert.equal(result.brandName, 'original-brand');
      for (const item of result.created) {
        assert.ok(result.destroyed.some(value => value.name === item.name && value.id === item.id), JSON.stringify(item));
      }
    });
  }
  for (const file of ['leave_request/requests_workspace_contract', 'team_view/sticky_header']) {
    for (const step of [1, 2, 3]) {
      it(`${file}: forwards setup failure ${step} once and closes only its driver`, function() {
        const result = run(`t/integration/${file}.js`, step);
        assert.deepEqual(result.setup, ['setup-error']);
        assert.deepEqual(result.cleanup, ['success']);
        assert.deepEqual(result.unhandled, []);
        assert.equal(result.quit, step === 1 ? 0 : 1);
        assert.equal(result.globalProcessQueries, 0);
        assert.equal(result.tempDirectories, 1, 'visual artifacts need an exclusive suite directory');
      });
    }
  }
});
