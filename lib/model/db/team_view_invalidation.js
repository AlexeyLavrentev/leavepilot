'use strict';

// Post-commit team-view invalidation (D-07..D-09).
//
// Sequelize 6.37.8 has NO model-level `afterCommit` hook (see the hook
// registry in node_modules/sequelize/lib/hooks.js): `afterCommit` exists only
// as `transaction.afterCommit(fn)`, which commit() runs in its `finally`
// block — so the callback also fires after a FAILED commit. A spurious bump
// is therefore possible and accepted: over-invalidation only ever costs a
// recompute, never staleness. Mutations saved with individualHooks would
// double-bump (instance hook plus bulk hook); that over-invalidation is
// tolerated too, and deliberately NO field allowlists are used — a wrong
// allowlist is exactly how mutation families get missed (D-08).
//
// The module is require-time side-effect free: it exports the family table
// and register(), which the model registry invokes after the association and
// scope passes, so edition models named in the table are hooked when present
// and queryInterface-based migrations are unaffected.

const log = require('../../logger');
const teamViewCache = require('../../cache/team_view_cache');

const HOOK_NAME = 'team_view_invalidation';

const INSTANCE_HOOKS = Object.freeze(['afterCreate', 'afterUpdate', 'afterDestroy']);
const BULK_HOOKS = Object.freeze(['afterBulkCreate', 'afterBulkUpdate', 'afterBulkDestroy']);

const distinct = values => [...new Set(values.filter(value => value !== null && value !== undefined && value !== ''))];

const firstPresent = (...values) => values.find(value => value !== undefined && value !== null && value !== '');

const whereValues = (where, key) => {
  const value = where ? where[key] : undefined;
  if (value === undefined || value === null) { return []; }
  return Array.isArray(value) ? value : [value];
};

// Resolvers answer the OWNING company ids for a mutation: a wrong resolver
// over- or under-invalidates instead of leaking cached HTML across tenants.
const resolveLeaveCompanyIds = async ({db, instance, instances, where}) => {
  const leaves = instances || (instance ? [instance] : []);
  const userIds = distinct(leaves.map(leave => firstPresent(
    leave.get ? leave.get('userId') : leave.userId
  )));
  userIds.push(...whereValues(where, 'userId'));

  // Rows destroyed in bulk by id cannot be re-fetched after the fact; resolve
  // the ids best effort (post-update rows still exist, post-destroy do not).
  const leaveIds = whereValues(where, 'id');
  if (leaveIds.length) {
    const rows = await db.Leave.findAll({where: {id: leaveIds}, attributes: ['userId']});
    userIds.push(...rows.map(row => row.userId));
  }

  if (!userIds.length) { return []; }
  const users = await db.User.findAll({where: {id: distinct(userIds)}, attributes: ['companyId']});
  return distinct(users.map(user => user.companyId));
};

const resolveDirectCompanyIds = ({instance, instances, where, directKey, whereKey = directKey}) => {
  const rows = instances || (instance ? [instance] : []);
  return distinct([
    ...rows.map(row => firstPresent(row.get ? row.get(directKey) : row[directKey])),
    ...whereValues(where, whereKey),
  ]);
};

// Ordered mutation-family table — the seed of the D-08 full audit. Expansion
// plans append families here; the registry pass, the completeness contract and
// the two-worker proof matrix all follow the table, never a hand-maintained
// hook list scattered across routes.
const _families = Object.freeze([
  Object.freeze({
    model: 'Leave',
    hooks: Object.freeze([...INSTANCE_HOOKS, ...BULK_HOOKS]),
    resolveCompanyIds: resolveLeaveCompanyIds,
  }),
  Object.freeze({
    model: 'User',
    hooks: Object.freeze([...INSTANCE_HOOKS, ...BULK_HOOKS]),
    resolveCompanyIds: ({instance, instances, where}) =>
      resolveDirectCompanyIds({instance, instances, where, directKey: 'companyId'}),
  }),
  Object.freeze({
    model: 'Department',
    hooks: Object.freeze([...INSTANCE_HOOKS, ...BULK_HOOKS]),
    resolveCompanyIds: ({instance, instances, where}) =>
      resolveDirectCompanyIds({instance, instances, where, directKey: 'companyId'}),
  }),
  Object.freeze({
    model: 'Company',
    hooks: Object.freeze([...INSTANCE_HOOKS, ...BULK_HOOKS]),
    resolveCompanyIds: ({instance, instances, where}) =>
      resolveDirectCompanyIds({instance, instances, where, directKey: 'id', whereKey: 'id'}),
  }),
]);

const bumpCompanies = async ({family, db, payload}) => {
  const companyIds = await family.resolveCompanyIds({db, ...payload});
  if (!companyIds.length) {
    log.error('team_view_invalidation_failed', {model: family.model, reason: 'company_unresolved'});
    return;
  }
  for (const companyId of companyIds) {
    await teamViewCache.bumpCompanyVersion(companyId);
  }
};

// The bump is fire-and-forget: it resolves the owning company, advances the
// shared version, and never lets a failure escape — model name and error
// message only in the red log, never raw error objects with transport details.
const fireBump = ({family, db, payload}) => {
  bumpCompanies({family, db, payload}).catch(error => {
    log.error('team_view_invalidation_failed', {model: family.model, err: error.message});
  });
};

// D-09: invalidation fires strictly after a successful commit. When the
// mutation ran inside a transaction, defer through transaction.afterCommit;
// otherwise the statement was autocommitted by hook time, so fire now.
const bumpAfterCommit = ({family, db, payload, options}) => {
  const transaction = options && options.transaction;
  if (transaction && typeof transaction.afterCommit === 'function') {
    // commit() awaits its afterCommit callbacks, so the callback must not
    // return the bump promise — a slow shared store must never block a commit.
    transaction.afterCommit(() => { fireBump({family, db, payload}); });
    return;
  }
  fireBump({family, db, payload});
};

const registeredModels = new WeakSet();

// Registers the family-table hooks on the (already associated) models. Skips
// models that are absent (edition families join through the registry when
// their edition is loaded) and is idempotent per model instance.
const register = ({db}) => {
  if (!db) {
    throw new Error('team_view_invalidation.register requires the model registry');
  }

  for (const family of _families) {
    const model = db[family.model];
    if (!model || typeof model.addHook !== 'function' || registeredModels.has(model)) {
      continue;
    }
    registeredModels.add(model);

    for (const hook of family.hooks) {
      if (hook === 'afterBulkCreate') {
        model.addHook(hook, HOOK_NAME, (instances, options) => {
          const rows = Array.isArray(instances) ? instances : [];
          if (rows.length === 0) { return; }
          bumpAfterCommit({family, db, payload: {instances: rows}, options});
        });
      } else if (hook === 'afterBulkUpdate' || hook === 'afterBulkDestroy') {
        model.addHook(hook, HOOK_NAME, (options) => {
          const where = options && options.where;
          if (!where || Object.keys(where).length === 0) { return; }
          bumpAfterCommit({family, db, payload: {where}, options});
        });
      } else {
        model.addHook(hook, HOOK_NAME, (instance, options) => {
          if (!instance) { return; }
          bumpAfterCommit({family, db, payload: {instance}, options});
        });
      }
    }
  }

  return _families;
};

module.exports = {
  register,
  _families,
};
