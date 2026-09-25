'use strict';

const assert = require('assert/strict');
const {randomBytes} = require('crypto');
const Sequelize = require('sequelize');
const session = require('express-session');

const dialect = process.env.TEST_DB_DIALECT;
const database = process.env.DB_NAME;
const sqlOptions = {
  dialect,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  storage: process.env.DB_STORAGE,
  logging: false,
  dialectOptions: dialect === 'mysql' ? {connectTimeout: 5000} : undefined,
};
const originalFactory = require('connect-session-sequelize');
const NativeStore = originalFactory(session.Store);
let capturedStore;
const callbackCounts = [];
const dependencyPath = require.resolve('connect-session-sequelize');
require.cache[dependencyPath].exports = Store => {
  const DependencyStore = originalFactory(Store);
  return class CapturedStore extends DependencyStore {
    constructor(options) {
      super(options);
      capturedStore = this;
    }
  };
};
const createSessionMiddleware = require('../../../lib/middleware/withSession');
require.cache[dependencyPath].exports = originalFactory;

const sid = () => randomBytes(18).toString('hex');
const future = () => new Date(Date.now() + 60 * 60 * 1000);
const sessionData = value => ({cookie: {expires: future()}, value});
const sessionCookie = response => response.headers.getSetCookie()
  .find(item => item.startsWith('connect.sid='));
const errorCode = error => String(error && (error.original && error.original.code || error.code || error.name) || 'unknown');

function call(store, method, ...args) {
  return new Promise((resolve, reject) => {
    const observed = {count: 0, method};
    callbackCounts.push(observed);
    const callback = (error, result) => {
      observed.count += 1;
      if (observed.count > 1) { return reject(new Error(`${method} called back more than once`)); }
      setImmediate(() => error ? reject(error) : resolve(result));
    };
    try {
      const returned = store[method](...args, callback);
      if (returned && typeof returned.catch === 'function') { returned.catch(() => {}); }
    } catch (error) { reject(error); }
  });
}

async function openStore(kind) {
  const db = new Sequelize(database, process.env.DB_USER, process.env.DB_PASSWORD, sqlOptions);
  let store;
  let close;
  let middleware = null;
  if (kind === 'current') {
    middleware = createSessionMiddleware({sequelizeDb: db});
    store = capturedStore;
    assert.equal(Object.hasOwn(db, 'import'), false, 'factory must not add a Sequelize import shim');
    for (const method of ['get', 'set', 'touch', 'destroy', 'length', 'clearExpiredSessions']) {
      assert.equal(Object.hasOwn(store, method), false, `${method} must use the native Store method`);
    }
    const initialization = middleware.sessionLifecycle.initialize();
    assert.equal(middleware.sessionLifecycle.initialize(), initialization);
    await initialization;
    close = async () => {
      const closing = middleware.sessionLifecycle.close();
      assert.equal(middleware.sessionLifecycle.close(), closing);
      await closing;
    };
  } else {
    store = new NativeStore({db});
    await store.sync();
    close = async () => store.stopExpiringSessions();
  }
  return {db, store, close, middleware};
}

async function closeStore(opened) {
  if (!opened) { return; }
  await opened.close();
  await opened.db.close();
}

async function exerciseCloseBeforeReady() {
  const db = new Sequelize(database, process.env.DB_USER, process.env.DB_PASSWORD, sqlOptions);
  const middleware = createSessionMiddleware({sequelizeDb: db});
  const states = [];
  middleware.sessionLifecycle.onStateChange(event => states.push(event.state));
  let releaseSync;
  capturedStore.sync = () => new Promise(resolve => { releaseSync = resolve; });
  try {
    const initializing = middleware.sessionLifecycle.initialize();
    await Promise.resolve();
    assert.equal(typeof releaseSync, 'function');
    await middleware.sessionLifecycle.close();
    releaseSync();
    await initializing;
    assert.equal(middleware.sessionLifecycle.isReady(), false);
    assert.deepEqual(states, []);
  } finally {
    await middleware.sessionLifecycle.close();
    await db.close();
  }
}

async function exercise(store, model, marker) {
  const observations = {independentWriteErrors: [], sameSidWriteErrors: []};
  const absent = sid();
  assert.equal(await call(store, 'get', absent), null);
  await call(store, 'destroy', absent);
  assert.equal(await call(store, 'get', absent), null);

  const key = sid();
  await call(store, 'set', key, sessionData(marker + '-first'));
  assert.equal((await call(store, 'get', key)).value, marker + '-first');
  await call(store, 'set', key, sessionData(marker + '-last'));
  assert.equal((await call(store, 'get', key)).value, marker + '-last');
  const touchedExpiry = new Date(Date.now() + 2 * 60 * 60 * 1000);
  await call(store, 'touch', key, {cookie: {expires: touchedExpiry}, value: 'ignored-touch-value'});
  assert.equal((await call(store, 'get', key)).value, marker + '-last');
  const touchedRecord = await model.findByPk(key);
  assert.equal(JSON.parse(touchedRecord.data).value, marker + '-last');
  assert.ok(Math.abs(new Date(touchedRecord.expires).getTime() - touchedExpiry.getTime()) < 2000);

  const expired = sid();
  await call(store, 'set', expired, {cookie: {expires: new Date(Date.now() - 1000)}, value: 'expired'});
  await call(store, 'clearExpiredSessions');
  assert.equal(await call(store, 'get', expired), null);

  const first = sid();
  const second = sid();
  const independentWrites = await Promise.allSettled([
    call(store, 'set', first, sessionData('independent-1')),
    call(store, 'set', second, sessionData('independent-2')),
  ]);
  observations.independentWriteErrors = independentWrites.filter(result => result.status === 'rejected')
    .map(result => errorCode(result.reason));
  if (dialect === 'sqlite') {
    assert.ok(observations.independentWriteErrors.every(code => code === 'SQLITE_BUSY'));
  }
  // Both writes have settled before recovery or connection close.
  if (independentWrites[0].status === 'rejected') { await call(store, 'set', first, sessionData('independent-1')); }
  if (independentWrites[1].status === 'rejected') { await call(store, 'set', second, sessionData('independent-2')); }
  const independent = await Promise.all([call(store, 'get', first), call(store, 'get', second)]);
  assert.equal(independent[0].value, 'independent-1');
  assert.equal(independent[1].value, 'independent-2');

  const simultaneous = await Promise.all([
    call(store, 'get', key),
    call(store, 'touch', key, sessionData('ignored-parallel-touch')),
  ]);
  assert.equal(simultaneous[0].value, marker + '-last');
  const racingWrites = await Promise.allSettled([
    call(store, 'set', key, sessionData('parallel-a')),
    call(store, 'set', key, sessionData('parallel-b')),
  ]);
  observations.sameSidWriteErrors = racingWrites.filter(result => result.status === 'rejected')
    .map(result => errorCode(result.reason));
  assert.ok([marker + '-last', 'parallel-a', 'parallel-b'].includes((await call(store, 'get', key)).value));
  await call(store, 'set', key, sessionData(marker + '-serial-final'));
  assert.equal((await call(store, 'get', key)).value, marker + '-serial-final');

  await call(store, 'destroy', key);
  await call(store, 'destroy', key);
  assert.equal(await call(store, 'get', key), null);

  for (const method of ['get', 'set', 'touch', 'destroy']) {
    assert.equal(typeof store[method], 'function');
  }
  return observations;
}

async function exerciseErrors(opened) {
  const testSid = sid();
  await opened.db.models.Session.drop();
  for (const [method, args] of [
    ['get', [testSid]], ['set', [testSid, sessionData('error')]],
    ['touch', [testSid, sessionData('error')]], ['destroy', [testSid]],
  ]) {
    await assert.rejects(() => call(opened.store, method, ...args));
  }
  await opened.store.sync();
}

async function exerciseMiddlewareFlags(opened) {
  const express = require('express');
  const app = express();
  const originalSet = opened.store.set;
  let sets = 0;
  opened.store.set = function(...args) { sets += 1; return originalSet.apply(this, args); };
  app.use(opened.middleware);
  app.get('/noop', (_req, res) => res.send('ok'));
  app.get('/write', (req, res) => { req.session.marker = 'written'; res.send('ok'); });
  let server;
  try {
    server = await require('../../../lib/server_listener').listen({app, port: 0, host: '127.0.0.1'});
    const base = `http://127.0.0.1:${server.address().port}`;
    const untouched = await fetch(base + '/noop');
    assert.equal(untouched.status, 200);
    await untouched.text();
    assert.equal(sessionCookie(untouched), undefined);
    assert.equal(sets, 0);
    const written = await fetch(base + '/write');
    assert.equal(written.status, 200);
    await written.text();
    const cookie = sessionCookie(written);
    assert.ok(cookie);
    assert.equal(sets, 1);
    const read = await fetch(base + '/noop', {headers: {cookie: cookie.split(';')[0]}});
    assert.equal(read.status, 200);
    await read.text();
    assert.equal(sets, 1);
    const sessionId = decodeURIComponent(cookie.split(';')[0].split('=')[1]).slice(2).split('.')[0];
    assert.equal((await call(opened.store, 'get', sessionId)).marker, 'written');
  } finally {
    if (server) { await new Promise(resolve => server.close(resolve)); }
    opened.store.set = originalSet;
  }
}

async function httpCase() {
  const secure = process.env.TEST_COOKIE_SECURE === 'true';
  const forwarded = secure ? {'x-forwarded-proto': 'https'} : {};
  const app = require('../../../app');
  const models = app.get('db_model');
  let server;
  try {
    await models.sequelize.sync({force: true});
    await app.get('session_middleware').sessionLifecycle.initialize();
    const company = await models.Company.create({name: 'Session Contract', country: 'GB', start_of_new_year: 1});
    const department = await models.Department.create({name: 'Test', companyId: company.id});
    const user = await models.User.create({
      name: 'Test', lastname: 'User', email: 'session-contract@example.test',
      password: models.User.hashify_password('test123'), companyId: company.id,
      DepartmentId: department.id, admin: true, activated: true,
    });
    await department.update({bossId: user.id});
    server = await require('../../../lib/server_listener').listen({app, port: 0, host: '127.0.0.1'});
    const base = `http://127.0.0.1:${server.address().port}`;
    const loginPage = await fetch(base + '/login/', {headers: forwarded});
    assert.equal(loginPage.status, 200);
    let cookie = sessionCookie(loginPage);
    assert.ok(cookie && cookie.includes('connect.sid='));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, secure ? /SameSite=None/i : /SameSite=Lax/i);
    if (secure) { assert.match(cookie, /; Secure/i); }
    else { assert.doesNotMatch(cookie, /; Secure/i); }
    const cookieExpiry = cookie.match(/Expires=([^;]+)/i);
    assert.ok(cookieExpiry);
    const expectedAge = secure ? 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
    assert.ok(Math.abs(Date.parse(cookieExpiry[1]) - Date.now() - expectedAge) < 60000);
    const csrf = (await loginPage.text()).match(/name=["']_csrf["'][^>]*value=["']([^"']+)/i);
    assert.ok(csrf);
    const beforeLogin = await models.sequelize.models.Session.findAll();
    assert.equal(beforeLogin.length, 1);
    assert.equal(JSON.parse(beforeLogin[0].data).csrf_token, csrf[1]);
    const login = await fetch(base + '/login/', {
      method: 'POST', redirect: 'manual',
      headers: {...forwarded, cookie: cookie.split(';')[0], 'content-type': 'application/x-www-form-urlencoded',
        'x-csrf-token': csrf[1]},
      body: new URLSearchParams({_csrf: csrf[1], email: user.email, password: 'test123'}),
    });
    assert.equal(login.status, 302);
    await login.text();
    assert.equal(login.headers.get('location'), '/');
    cookie = sessionCookie(login);
    assert.ok(cookie && cookie.includes('connect.sid='));
    const active = await fetch(base + '/calendar/', {headers: {...forwarded, cookie: cookie.split(';')[0]}});
    assert.equal(active.status, 200);
    await active.text();
    const sessionId = decodeURIComponent(cookie.split(';')[0].split('=')[1]).slice(2).split('.')[0];
    const logout = await fetch(base + '/logout/', {redirect: 'manual', headers: {...forwarded, cookie: cookie.split(';')[0]}});
    assert.equal(logout.status, 302);
    await logout.text();
    assert.equal(await call(capturedStore, 'get', sessionId), null);
    const after = await fetch(base + '/calendar/', {redirect: 'manual', headers: {...forwarded, cookie: cookie.split(';')[0]}});
    assert.equal(after.status, 303);
    await after.text();
    return {httpLoginLogout: true, cookieContract: true};
  } finally {
    if (server) { await new Promise(resolve => server.close(resolve)); }
    await app.get('session_middleware').sessionLifecycle.close();
    await models.sequelize.close();
  }
}

async function runStoreCase() {
  assert.ok(dialect === 'sqlite' || dialect === 'mysql');
  assert.ok(/^lp_session_[a-f0-9]{24}$/.test(database));
  let opened;
  let stage = 'open-current';
  const observations = {};
  const shared = sid();
  const legacySid = sid();
  try {
    opened = await openStore('current');
    stage = 'exercise-current';
    observations.current = await exercise(opened.store, opened.db.models.Session, 'current');
    await exerciseMiddlewareFlags(opened);
    await exerciseErrors(opened);
    await call(opened.store, 'set', shared, sessionData('from-current'));
    // The removed shim wrote JSON data and a DATE expiry in this existing table.
    // Seed its persisted representation directly so a later native run still
    // proves pre-removal sessions remain readable.
    await opened.db.models.Session.create({
      sid: legacySid,
      data: JSON.stringify(sessionData('legacy-shim')),
      expires: future(),
    });
    await closeStore(opened);
    opened = null;

    stage = 'open-native';
    opened = await openStore('native');
    stage = 'exercise-native';
    assert.equal((await call(opened.store, 'get', shared)).value, 'from-current');
    assert.equal((await call(opened.store, 'get', legacySid)).value, 'legacy-shim');
    observations.native = await exercise(opened.store, opened.db.models.Session, 'native');
    await exerciseErrors(opened);
    await call(opened.store, 'set', shared, sessionData('from-native'));
    // exerciseErrors drops the table; restore the archived row for the
    // subsequent application-Store read across this restart.
    await opened.db.models.Session.create({
      sid: legacySid,
      data: JSON.stringify(sessionData('legacy-shim')),
      expires: future(),
    });
    await closeStore(opened);
    opened = null;

    stage = 'reopen-current';
    opened = await openStore('current');
    assert.equal((await call(opened.store, 'get', shared)).value, 'from-native');
    assert.equal((await call(opened.store, 'get', legacySid)).value, 'legacy-shim');
    await call(opened.store, 'destroy', shared);
    await call(opened.store, 'destroy', legacySid);
    await closeStore(opened);
    opened = null;
    stage = 'http';
    const http = await httpCase();
    stage = 'close-before-ready';
    await exerciseCloseBeforeReady();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(callbackCounts.length > 0 && callbackCounts.every(item => item.count === 1));
    console.log(JSON.stringify({dialect, stores: ['current', 'native', 'current'],
      publicContract: true, crossRestart: true, observations, ...http}));
  } catch (error) {
    error.message = `${stage}: ${error.message}`;
    throw error;
  } finally { await closeStore(opened); }
}

async function runHttpAgentReady() {
  const agent = require('../../lib/http_agent');
  try {
    await agent.ready();
    assert.equal(agent.getApp().get('session_middleware').sessionLifecycle.isReady(), true);
    console.log(JSON.stringify({httpAgentReady: true}));
  } finally { await agent.close(); }
}

async function runSecureHttp() {
  assert.ok(/^lp_session_[a-f0-9]{24}$/.test(database));
  const result = await httpCase();
  console.log(JSON.stringify(result));
}

const mode = process.argv[2];
(mode === 'http-agent-ready' ? runHttpAgentReady()
  : mode === 'http-secure' ? runSecureHttp() : runStoreCase())
  .catch(error => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
