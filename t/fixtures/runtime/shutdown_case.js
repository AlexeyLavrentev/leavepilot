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
  if (mode === 'delayed-save' && !savePending) {
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
});
app.set('db_model', {
  sequelize: {
    close: () => {
      send('sql-close');
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
  shutdownTimeoutMs: 250,
  listen: async context => {
    server = await require('../../../lib/server_listener').listen({...context, port: 0, host: '127.0.0.1'});
    const originalCloseServer = server.close.bind(server);
    server.close = callback => {
      send('listener-closing');
      return originalCloseServer(callback);
    };
    return server;
  },
  startSchedulers: () => [],
  sendReady: () => send('ready', {port: server.address().port}),
  exit: code => send('exit', {code}, () => process.exit(code)),
}).start();
