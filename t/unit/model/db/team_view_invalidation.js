'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

// The registry reads its dialect/storage from the environment at require
// time, so the SQLite contour is selected before lib/model/db loads.
process.env.DB_DIALECT = process.env.DB_DIALECT || 'sqlite';
process.env.DB_STORAGE = process.env.DB_STORAGE
  || path.join(os.tmpdir(), `lp-tv-invalidation-${process.pid}.sqlite`);

const model = require('../../../../lib/model/db');
const teamViewCache = require('../../../../lib/cache/team_view_cache');
const {_families} = require('../../../../lib/model/db/team_view_invalidation');
const log = require('../../../../lib/logger');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await wait(5);
  }
  assert.ok(predicate(), 'condition did not become true');
}

// Counting shared-store double: bumps per company are visible as incr calls
// on teamview:version:{companyId}. Injected through the cache _reset seam so
// the invalidation module exercises its real production code path.
function countingClient() {
  const client = new EventEmitter();
  client.isOpen = true;
  client.connect = async () => {};
  client.close = async () => { client.isOpen = false; };
  client.destroy = () => { client.isOpen = false; };
  client.bumps = new Map();
  client.get = async () => null;
  client.set = async () => 'OK';
  client.setEx = async () => 'OK';
  client.incr = async key => {
    client.bumps.set(key, (client.bumps.get(key) || 0) + 1);
    return client.bumps.get(key);
  };
  return client;
}

const recorded = [];
const originalError = log.error;
const errorLogs = () => recorded.filter(([level]) => level === 'error');

describe('team view invalidation hooks', function() {
  this.timeout(10000);

  let company1;
  let company2;
  let user1;
  let client;
  const bumpCount = companyId => client.bumps.get(`teamview:version:${companyId}`) || 0;

  before(async function() {
    await model.sequelize.sync();
    company1 = await model.Company.create({name: 'InvOne', country: 'GB', start_of_new_year: 1});
    company2 = await model.Company.create({name: 'InvTwo', country: 'GB', start_of_new_year: 1});
    user1 = await model.User.create({
      name: 'Leave',
      lastname: 'Owner',
      email: 'tv-invalidation-owner@example.test',
      password: model.User.hashify_password('unit-only-password'),
      companyId: company1.id,
    });
    await model.User.create({
      name: 'Other',
      lastname: 'Company',
      email: 'tv-invalidation-other@example.test',
      password: model.User.hashify_password('unit-only-password'),
      companyId: company2.id,
    });
  });

  beforeEach(function() {
    recorded.length = 0;
    log.error = (...args) => recorded.push(['error', ...args]);
    client = countingClient();
    teamViewCache._reset({
      client,
      ready: true,
      sessionStore: {useRedis: true, redisConnectionConfiguration: {host: 'unit-host', port: 6379}},
    });
  });

  afterEach(function() {
    log.error = originalError;
  });

  after(async function() {
    try {
      await teamViewCache.close();
    } finally {
      teamViewCache._reset();
      await model.sequelize.close();
      fs.rmSync(process.env.DB_STORAGE, {force: true});
    }
  });

  it('bumps the owning company immediately for a non-transactional leave create', async function() {
    // The naive alternative — registering a literal afterCommit model hook —
    // never fires in Sequelize 6; this test fails under that approach.
    const before = bumpCount(company1.id);
    const otherBefore = bumpCount(company2.id);
    await model.Leave.create({
      userId: user1.id,
      status: model.Leave.status_new(),
      date_start: '2026-10-05',
      date_end: '2026-10-06',
      day_part_start: 1,
      day_part_end: 1,
    });
    await until(() => bumpCount(company1.id) === before + 1);
    assert.equal(bumpCount(company2.id), otherBefore, 'the hop resolves the owning company only');
  });

  it('advances the version only after the transaction commits', async function() {
    const before = bumpCount(company1.id);
    await model.sequelize.transaction(async transaction => {
      await model.Leave.create({
        userId: user1.id,
        status: model.Leave.status_new(),
        date_start: '2026-11-05',
        date_end: '2026-11-06',
      }, {transaction});
      await wait(80);
      assert.equal(bumpCount(company1.id), before, 'no bump before commit');
    });
    await until(() => bumpCount(company1.id) === before + 1);
  });

  it('never bumps for a rolled-back transaction', async function() {
    const before = bumpCount(company1.id);
    await model.sequelize.transaction(async transaction => {
      await model.Leave.create({
        userId: user1.id,
        status: model.Leave.status_new(),
        date_start: '2026-12-05',
        date_end: '2026-12-06',
      }, {transaction});
      throw new Error('rollback-on-purpose');
    }).catch(() => {});
    await wait(120);
    assert.equal(bumpCount(company1.id), before);
  });

  it('bumps user create, update and destroy with the direct company id', async function() {
    const before = bumpCount(company2.id);
    const user = await model.User.create({
      name: 'Direct',
      lastname: 'User',
      email: 'tv-invalidation-direct@example.test',
      password: model.User.hashify_password('unit-only-password'),
      companyId: company2.id,
    });
    await until(() => bumpCount(company2.id) === before + 1);

    await user.update({name: 'DirectRenamed'});
    await until(() => bumpCount(company2.id) === before + 2);

    await user.destroy();
    await until(() => bumpCount(company2.id) === before + 3);
  });

  it('bumps department create, update and destroy with the direct company id', async function() {
    const before = bumpCount(company1.id);
    const department = await model.Department.create({name: 'InvDepartment', companyId: company1.id});
    await until(() => bumpCount(company1.id) === before + 1);

    await department.update({name: 'InvDepartmentRenamed'});
    await until(() => bumpCount(company1.id) === before + 2);

    await department.destroy();
    await until(() => bumpCount(company1.id) === before + 3);
  });

  it('bumps a company update with the company id', async function() {
    const before = bumpCount(company1.id);
    await company1.update({name: 'InvOneRenamed'});
    await until(() => bumpCount(company1.id) === before + 1);
  });

  it('resolves bulk update and destroy companies from the where clause', async function() {
    const updateBefore = bumpCount(company1.id);
    await model.User.update({name: 'BulkRenamed'}, {where: {companyId: company1.id}});
    await until(() => bumpCount(company1.id) === updateBefore + 1);

    const destroyBefore = bumpCount(company2.id);
    await model.Department.destroy({where: {companyId: company2.id}});
    await until(() => bumpCount(company2.id) === destroyBefore + 1);
  });

  it('resolves a leave bulk destroy from the where clause through the user hop', async function() {
    await model.Leave.create({
      userId: user1.id,
      status: model.Leave.status_new(),
      date_start: '2026-10-20',
      date_end: '2026-10-21',
    });
    const before = bumpCount(company1.id);
    // The real user-removal flow destroys leaves by userId, which the hop can
    // resolve; destroying by id cannot be re-fetched post-destroy and logs
    // red instead (covered by the unresolved-where contract below).
    await model.Leave.destroy({where: {userId: user1.id}});
    await until(() => bumpCount(company1.id) > before, 2000);
    assert.ok(bumpCount(company1.id) >= before + 1);
  });

  it('bumps each distinct company exactly once for a bulk create spanning two companies', async function() {
    const before1 = bumpCount(company1.id);
    const before2 = bumpCount(company2.id);
    await model.Department.bulkCreate([
      {name: 'BulkA', companyId: company1.id},
      {name: 'BulkB', companyId: company1.id},
      {name: 'BulkC', companyId: company2.id},
    ]);
    await until(() => bumpCount(company1.id) === before1 + 1 && bumpCount(company2.id) === before2 + 1);
  });

  it('produces no bump and no log for an empty instances array', async function() {
    const before = bumpCount(company1.id);
    await model.Department.bulkCreate([]);
    await wait(80);
    assert.equal(bumpCount(company1.id), before);
    assert.equal(errorLogs().length, 0);
  });

  it('logs red without throwing when the where clause resolves no company', async function() {
    await model.Department.update({name: 'NoCompany'}, {where: {name: 'no-such-department-name'}});
    await until(() => errorLogs().some(([, event]) => event === 'team_view_invalidation_failed'));
    const failures = errorLogs().filter(([, event]) => event === 'team_view_invalidation_failed');
    assert.ok(failures.length >= 1);
    assert.ok(failures.some(([, , meta]) => meta && meta.model === 'Department'));
  });

  it('registers exactly the family-table hooks on each model', function() {
    const expected = new Set();
    for (const family of _families) {
      const familyModel = model[family.model];
      assert.ok(familyModel, `family model ${family.model} is missing from the registry`);
      for (const hook of family.hooks) {
        expected.add(`${family.model}.${hook}`);
        const hooks = (familyModel.options.hooks && familyModel.options.hooks[hook]) || [];
        assert.ok(
          hooks.some(entry => entry && entry.name === 'team_view_invalidation'),
          `${family.model}.${hook} is not registered`
        );
      }
    }

    const registered = new Set();
    for (const [name, familyModel] of Object.entries(model)) {
      const hooksByName = familyModel && familyModel.options && familyModel.options.hooks;
      if (!hooksByName) { continue; }
      for (const [hook, hooks] of Object.entries(hooksByName)) {
        if ((hooks || []).some(entry => entry && entry.name === 'team_view_invalidation')) {
          registered.add(`${name}.${hook}`);
        }
      }
    }
    assert.deepEqual([...registered].sort(), [...expected].sort());
  });
});
