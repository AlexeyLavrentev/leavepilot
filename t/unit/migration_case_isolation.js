'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');

async function runSuite({failCreate = 0, failDrop = 0} = {}) {
  const filename = path.resolve(__dirname, 'db_migrations_data.js');
  const localRequire = createRequire(filename);
  const queries = [];
  const hooks = {};
  let created = 0;
  let dropped = 0;
  let closed = false;
  const maintenance = class {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('CREATE') && ++created === failCreate) { throw new Error('synthetic create failure'); }
      if (sql.startsWith('DROP') && ++dropped === failDrop) { throw new Error('synthetic drop failure'); }
    }
    async close() { closed = true; }
  };
  const requireFixture = name => {
    if (name === 'sequelize') { return maintenance; }
    if (name === '../fixtures/data-rewriting-migrations.json') {
      return {migrations: localRequire(name).migrations.slice(0, 1)};
    }
    if (name === 'child_process') {
      return {spawn(_command, args) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        process.nextTick(() => {
          child.stdout.emit('data', JSON.stringify({ok: true, migration: args[1], dialect: 'mysql', assertions: 20}) + '\n');
          child.emit('exit', 0, null);
        });
        return child;
      }};
    }
    return localRequire(name);
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: requireFixture, __dirname: path.dirname(filename),
    process: {env: {...process.env, DB_DIALECT: 'mysql'}, execPath: process.execPath},
    setTimeout, clearTimeout,
    describe(_name, body) { body.call({timeout() {}}); },
    before(body) { hooks.before = body; }, after(body) { hooks.after = body; },
    it(_name, body) { hooks.test = body; },
  }, {filename});
  let runError;
  let cleanupError;
  try { await hooks.before(); await hooks.test(); }
  catch (error) { runError = error; }
  finally { try { await hooks.after(); } catch (error) { cleanupError = error; } }
  return {queries, closed, runError, cleanupError};
}

describe('migration replay database ownership', function() {
  it('uses unique case and negative databases across independent runs', async function() {
    const first = await runSuite();
    const second = await runSuite();
    assert.ifError(first.runError); assert.ifError(first.cleanupError);
    const creates = result => result.queries.filter(sql => sql.startsWith('CREATE'));
    assert.equal(creates(first).length, 2);
    assert.equal(creates(second).length, 2);
    for (const sql of creates(first)) {
      assert.match(sql, /^CREATE DATABASE `lp_migr_[a-f0-9]{32}(?:_neg)?`$/);
      assert.ok(!creates(second).includes(sql));
    }
  });

  it('does not drop a database after its creation failed', async function() {
    const result = await runSuite({failCreate: 1});
    assert.match(result.runError.message, /create failure/);
    assert.deepEqual(result.queries.filter(sql => sql.startsWith('DROP')), []);
    assert.equal(result.closed, true);
  });

  it('cleans only the owned first database if negative database creation fails', async function() {
    const result = await runSuite({failCreate: 2});
    assert.match(result.runError && result.runError.message || '', /create failure/);
    const drops = result.queries.filter(sql => sql.startsWith('DROP'));
    assert.equal(drops.length, 1);
    assert.equal(drops[0].match(/`([^`]+)`/)[1], result.queries[0].match(/`([^`]+)`/)[1]);
    assert.equal(result.closed, true);
  });

  it('attempts both owned drops and closes the connection even if one drop fails', async function() {
    const result = await runSuite({failDrop: 1});
    assert.match(result.cleanupError.message, /drop failure/);
    assert.equal(result.queries.filter(sql => sql.startsWith('DROP')).length, 2);
    assert.equal(result.closed, true);
  });

  for (const env of [
    {DB_DIALECT: 'mysql', DB_NAME: 'operator_database', CASE_NEG_DB: 'operator_database_neg'},
    {DB_DIALECT: 'mysql', DB_NAME: 'lp_migr_' + 'a'.repeat(32), CASE_NEG_DB: 'another_database'},
    {DB_DIALECT: 'sqlite', CASE_SLUG: '../outside', CASE_STORAGE_DIR: '/tmp', DB_STORAGE: '/tmp/outside.sqlite'},
  ]) {
    it(`rejects unsafe child database identity: ${env.DB_NAME || env.CASE_SLUG}`, function() {
      const result = spawnSync(process.execPath, [path.resolve(__dirname, '../lib/db_migrations_data_case.js'), '20170329060832-rename_allowence_to_allowance.js'], {
        env: {...process.env, ...env, DB_HOST: '127.0.0.1', DB_PORT: '1'},
        encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /ERR_ASSERTION/);
      assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
    });
  }
});
