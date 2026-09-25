'use strict';

const express = require('express');
const Sequelize = require('sequelize');
const originalFactory = require('connect-session-sequelize');
const mode = process.argv[2];
let store;
let server;

const dependencyPath = require.resolve('connect-session-sequelize');
require.cache[dependencyPath].exports = Store => {
  const NativeStore = originalFactory(Store);
  return class CapturedStore extends NativeStore {
    constructor(options) {
      super(options);
      store = this;
    }
  };
};
const createSessionMiddleware = require('../../../lib/middleware/withSession');
require.cache[dependencyPath].exports = originalFactory;
const {startRuntime} = require('../../../lib/runtime_startup');

const send = (event, details = {}, callback) => {
  if (process.send) { process.send({event, ...details}, callback); }
};
const sequelize = new Sequelize({dialect: 'sqlite', storage: ':memory:', logging: false});
const app = express();
const middleware = createSessionMiddleware({sequelizeDb: sequelize});
let releaseSave;
let savePending = false;
const originalSet = store.set.bind(store);
store.set = (sid, data, callback) => {
  if ((mode === 'delayed-save' || mode === 'delayed-job') && !savePending) {
    savePending = true;
    send('save-pending');
    releaseSave = () => originalSet(sid, data, error => {
      send('save-complete');
      callback(error);
    });
    return;
  }
  originalSet(sid, data, callback);
};
process.on('message', message => {
  if (message.event === 'release-save' && releaseSave) { releaseSave(); }
  if (message.event === 'release-job' && releaseJob) { releaseJob(); }
});
let releaseJob;
app.set('db_model', {
  sequelize: {
    close: async () => {
      const persisted = mode === 'delayed-save' || mode === 'delayed-job'
        ? await sequelize.models.Session.count() : undefined;
      send('sql-close', {persisted});
      if (mode === 'hung-sql') { return new Promise(() => {}); }
      return sequelize.close();
    },
  },
  connect: () => sequelize.authenticate(),
});
app.set('session_middleware', middleware);
app.use(middleware);
app.get('/write', (req, res) => {
  req.session.marker = 'persisted';
  res.send('saved');
});
app.get('/stall', (_req, _res) => { send('request-entered'); });

const lifecycle = middleware.sessionLifecycle;
const originalClose = lifecycle.close.bind(lifecycle);
lifecycle.close = () => {
  send('store-close');
  if (mode === 'reject-store') {
    return Promise.reject(Object.assign(new Error('store failed'), {code: 'TEST_STORE_FAIL'}));
  }
  return originalClose();
};

startRuntime({
  loadApp: () => app,
  startupTimeoutMs: 1000,
  shutdownTimeoutMs: mode === 'delayed-save' || mode === 'delayed-job' ? 1000 : 250,
  listen: async context => {
    server = await require('../../../lib/server_listener').listen({...context, port: 0, host: '127.0.0.1'});
    const originalCloseServer = server.close.bind(server);
    server.close = callback => {
      send('listener-closing');
      return originalCloseServer(callback);
    };
    return server;
  },
  startSchedulers: () => {
    if (mode !== 'delayed-job') { return []; }
    const scheduler = require('../../../lib/scheduler/leave_start_reminders');
    const taskLock = require('../../../lib/scheduler/task_lock');
    const reminders = require('../../../lib/model/leave/reminder_scheduler');
    process.env.LEAVE_REMINDER_SCHEDULER_ENABLED = 'true';
    taskLock.tryAcquireTaskLock = async () => ({acquired: true, lock: {}, lockedBy: 'fixture'});
    taskLock.releaseTaskLock = async () => { send('lock-release'); };
    reminders.sendLeaveStartReminders = () => new Promise(resolve => {
      send('job-pending');
      releaseJob = () => resolve([]);
    });
    const originalSetTimeout = global.setTimeout;
    let fireJob;
    global.setTimeout = callback => { fireJob = callback; return {unref() {}}; };
    const handle = scheduler.startLeaveReminderScheduler({models: {}, logger: {log() {}, error() {}}});
    global.setTimeout = originalSetTimeout;
    setImmediate(fireJob);
    return [{name: 'leave_start_reminders', handle}];
  },
  sendReady: () => send('ready', {port: server.address().port}),
  exit: code => send('exit', {code}, () => process.exit(code)),
}).start();
