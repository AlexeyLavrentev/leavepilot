'use strict';

const assert = require('node:assert/strict');
const config = require('../../../lib/config');

const host = process.env.TEST_SESSION_HOST;
const port = Number(process.env.TEST_SESSION_PORT);
assert.equal(process.env.TEST_SESSION_BACKEND, 'redis');
assert.ok(host && Number.isInteger(port) && port > 0);
config.set('sessionStore', {
  useRedis: true,
  redisConnectionConfiguration: {host, port},
});

async function main() {
  const app = require('../../../app');
  const models = app.get('db_model');
  await models.sequelize.sync({force: true});
  const company = await models.Company.create({name: 'Redis lifecycle', country: 'GB', start_of_new_year: 1});
  const department = await models.Department.create({name: 'Test', companyId: company.id});
  const user = await models.User.create({
    name: 'Test', lastname: 'User', email: 'redis-lifecycle@example.test',
    password: models.User.hashify_password('test123'), companyId: company.id,
    DepartmentId: department.id, admin: true, activated: true,
  });
  await department.update({bossId: user.id});
  models.assertSchemaReady = async () => {};

  const lifecycle = app.get('session_middleware').sessionLifecycle;
  lifecycle.onStateChange(({state}) => {
    if (process.send) { process.send({event: `session-${state}`, pid: process.pid}); }
  });
  const {startRuntime} = require('../../../lib/runtime_startup');
  const runtime = startRuntime({
    loadApp: () => app,
    shutdownTimeoutMs: 1000,
    listen: options => require('../../../lib/server_listener').listen({...options, port: 0, host: '127.0.0.1'}),
    startSchedulers: () => [],
    sendReady: () => {},
    exit: code => { if (process.send) { process.send({event: 'exit', code}); } process.exit(code); },
  });
  const server = await runtime.start();
  if (server && process.send) {
    process.send({event: 'ready', port: server.address().port, pid: process.pid});
  }
}

main().catch(error => {
  process.stderr.write(String(error.stack || error));
  process.exitCode = 1;
});
