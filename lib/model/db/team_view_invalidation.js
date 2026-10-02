'use strict';

// Post-commit team-view invalidation (D-07..D-09).
//
// The ordered `_families` array below is the complete D-08 audit artifact:
// one row per audited mutation family that affects rendered team-view
// output, plus documented non-registering rows for the audited-and-excluded
// families. The registry pass, the completeness unit contract and the
// two-worker proof matrix all follow this table — never a hand-maintained
// hook list scattered across routes. Audit family numbers in the row
// comments refer to the 25-family table in 03-RESEARCH.md.
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

const rowValues = (rows, key) =>
  distinct(rows.map(row => firstPresent(row.get ? row.get(key) : row[key])));

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

// Hop resolvers (T-03-01): they traverse authenticated model associations
// only and answer the OWNING company. A failed hop is an unresolved red log,
// never a cross-tenant write — per-company version keys keep every effect
// scoped to the resolved company.

// user_id/userId → User.companyId (schedules, allowance adjustments, user groups).
const resolveUserHopCompanyIds = async ({db, instance, instances, where, userKey}) => {
  const rows = instances || (instance ? [instance] : []);
  const userIds = distinct([
    ...rowValues(rows, userKey),
    ...whereValues(where, userKey),
  ]);
  if (!userIds.length) { return []; }
  const users = await db.User.findAll({where: {id: userIds}, attributes: ['companyId']});
  return distinct(users.map(user => user.companyId));
};

// department_id → Department.companyId (supervisor links, audit family 13).
const resolveDepartmentHopCompanyIds = async ({db, instance, instances, where}) => {
  const rows = instances || (instance ? [instance] : []);
  const departmentIds = distinct([
    ...rowValues(rows, 'department_id'),
    ...whereValues(where, 'department_id'),
  ]);
  if (!departmentIds.length) { return []; }
  const departments = await db.Department.findAll({where: {id: departmentIds}, attributes: ['companyId']});
  return distinct(departments.map(department => department.companyId));
};

// Direct companyId plus the workCalendarId hop used by the work-calendar
// cascade (audit family 18): bank holidays are bulk-destroyed by
// workCalendarId BEFORE the calendar row itself goes away, so the hop can
// still read the owning company from the surviving WorkCalendar row.
const resolveBankHolidayCompanyIds = async ({db, instance, instances, where}) => {
  const direct = resolveDirectCompanyIds({instance, instances, where, directKey: 'companyId'});
  const rows = instances || (instance ? [instance] : []);
  const calendarIds = distinct([
    ...rowValues(rows, 'workCalendarId'),
    ...whereValues(where, 'workCalendarId'),
  ]);
  if (!calendarIds.length || !db.WorkCalendar) { return direct; }
  const calendars = await db.WorkCalendar.findAll({where: {id: calendarIds}, attributes: ['companyId']});
  return distinct([...direct, ...calendars.map(calendar => calendar.companyId)]);
};

// Audit family 19: company-wide schedules carry company_id, user-specific
// ones carry user_id only — resolve both shapes and deduplicate.
const resolveScheduleCompanyIds = async ({db, instance, instances, where}) => {
  const direct = resolveDirectCompanyIds({instance, instances, where, directKey: 'company_id'});
  const hopped = await resolveUserHopCompanyIds({db, instance, instances, where, userKey: 'user_id'});
  return distinct([...direct, ...hopped]);
};

// Employee-group membership (Pitfall 11): resolve through BOTH associations —
// userId → User.companyId and groupId → Group.companyId — so a row whose
// group was already destroyed still resolves through its user.
const resolveUserGroupCompanyIds = async ({db, instance, instances, where}) => {
  const viaUsers = await resolveUserHopCompanyIds({db, instance, instances, where, userKey: 'userId'});
  const rows = instances || (instance ? [instance] : []);
  const groupIds = distinct([
    ...rowValues(rows, 'groupId'),
    ...whereValues(where, 'groupId'),
  ]);
  if (!groupIds.length || !db.Group) { return viaUsers; }
  const groups = await db.Group.findAll({where: {id: groupIds}, attributes: ['companyId']});
  return distinct([...viaUsers, ...groups.map(group => group.companyId)]);
};

// Ordered mutation-family table — the complete D-08 audit artifact. Registering
// rows carry the hooks and the companyId resolver; audited families that never
// affect rendered team-view output appear as excluded rows with their reason,
// so the table IS the audit. The registry pass, the completeness contract and
// the two-worker proof matrix all follow the table, never a hand-maintained
// hook list scattered across routes.
const _families = Object.freeze([
  // Audit families 1-5: leave create/approve/reject/revoke/cancel + bulk.
  Object.freeze({
    model: 'Leave',
    hooks: Object.freeze([...INSTANCE_HOOKS, ...BULK_HOOKS]),
    resolveCompanyIds: resolveLeaveCompanyIds,
  }),
  // Audit families 6-11: user CRUD and import — including the two former gaps,
  // admin registration (7, bin/create_admin.js) and CSV import (8,
  // lib/model/user_importer.js per-user create), now covered automatically.
  Object.freeze({
    model: 'User',
    hooks: Object.freeze([...INSTANCE_HOOKS, ...BULK_HOOKS]),
    resolveCompanyIds: ({instance, instances, where}) =>
      resolveDirectCompanyIds({instance, instances, where, directKey: 'companyId'}),
  }),
  // Audit family 12: department create/update/destroy.
  Object.freeze({
    model: 'Department',
    hooks: Object.freeze([...INSTANCE_HOOKS, ...BULK_HOOKS]),
    resolveCompanyIds: ({instance, instances, where}) =>
      resolveDirectCompanyIds({instance, instances, where, directKey: 'companyId'}),
  }),
  // Audit family 14: company settings (general, integration API, LDAP, SSO).
  Object.freeze({
    model: 'Company',
    hooks: Object.freeze([...INSTANCE_HOOKS, ...BULK_HOOKS]),
    resolveCompanyIds: ({instance, instances, where}) =>
      resolveDirectCompanyIds({instance, instances, where, directKey: 'id', whereKey: 'id'}),
  }),
  // Audit family 15: leave type CRUD (statistics/legend per type) — former gap.
  Object.freeze({
    model: 'LeaveType',
    hooks: Object.freeze([...INSTANCE_HOOKS, ...BULK_HOOKS]),
    resolveCompanyIds: ({instance, instances, where}) =>
      resolveDirectCompanyIds({instance, instances, where, directKey: 'companyId'}),
  }),
  // Audit families 16-17: bank holiday CRUD and the calendar-preset bulk
  // import (companyId in the where clause) — former gaps.
  Object.freeze({
    model: 'BankHoliday',
    hooks: Object.freeze([...INSTANCE_HOOKS, ...BULK_HOOKS]),
    resolveCompanyIds: resolveBankHolidayCompanyIds,
  }),
  // Audit family 18: work calendar create / cascade destroy — former gap.
  Object.freeze({
    model: 'WorkCalendar',
    hooks: Object.freeze([...INSTANCE_HOOKS, ...BULK_HOOKS]),
    resolveCompanyIds: ({instance, instances, where}) =>
      resolveDirectCompanyIds({instance, instances, where, directKey: 'companyId'}),
  }),
  // Audit family 19: schedule save/destroy, company-wide and user-specific —
  // former gap (working days shape the rendered calendar).
  Object.freeze({
    model: 'Schedule',
    hooks: Object.freeze([...INSTANCE_HOOKS, ...BULK_HOOKS]),
    resolveCompanyIds: resolveScheduleCompanyIds,
  }),
  // Audit family 13: supervisor links (bulk destroy + bulkCreate inside the
  // departments.js transaction) — hop department_id, defer to that commit.
  Object.freeze({
    model: 'DepartmentSupervisor',
    hooks: Object.freeze([...INSTANCE_HOOKS, ...BULK_HOOKS]),
    resolveCompanyIds: resolveDepartmentHopCompanyIds,
  }),
  // Audit family 20: allowance adjustments — conservatively included via the
  // user hop (RESEARCH A1): over-invalidate rather than risk staleness.
  Object.freeze({
    model: 'UserAllowanceAdjustment',
    hooks: Object.freeze([...INSTANCE_HOOKS, ...BULK_HOOKS]),
    resolveCompanyIds: ({db, instance, instances, where}) =>
      resolveUserHopCompanyIds({db, instance, instances, where, userKey: 'user_id'}),
  }),
  // Pitfall 11: employee groups filter the rendered team view
  // (related_groups/current_group); community ships the models even though
  // only edition code mutates them — they register whenever present.
  Object.freeze({
    model: 'Group',
    hooks: Object.freeze([...INSTANCE_HOOKS, ...BULK_HOOKS]),
    resolveCompanyIds: ({instance, instances, where}) =>
      resolveDirectCompanyIds({instance, instances, where, directKey: 'companyId'}),
  }),
  Object.freeze({
    model: 'UserGroup',
    hooks: Object.freeze([...INSTANCE_HOOKS, ...BULK_HOOKS]),
    resolveCompanyIds: resolveUserGroupCompanyIds,
  }),
  // Audit families 21-25: audited and deliberately excluded. These rows
  // register nothing; they document WHY each family is out of scope so the
  // table remains the complete, auditable D-08 artifact.
  Object.freeze({
    excluded: true,
    family: 'company remover CLI',
    reason: 'Company removal destroys the company itself (lib/model/company/remover.js); '
      + 'bumping a version key for a company that no longer exists is pointless — the '
      + 'per-model hooks that fire inside the removal transaction already cover it.',
  }),
  Object.freeze({
    excluded: true,
    family: 'leave notification records',
    reason: 'Leave notification records are delivery bookkeeping '
      + '(lib/model/leave/reminder_scheduler.js), not rendered team-view output.',
  }),
  Object.freeze({
    excluded: true,
    family: 'comments',
    reason: 'Comments are created through the uncached leave-summary popup '
      + '(lib/model/comment.js); they never appear in the cached team-view HTML.',
  }),
  Object.freeze({
    excluded: true,
    family: 'audit, email audit, user feed and reminder schedules',
    reason: 'Audit, EmailAudit, UserFeed and ReminderSchedule rows are operational '
      + 'trails (settings/audit/feed/reminder routes); none feeds the rendered team view.',
  }),
  Object.freeze({
    excluded: true,
    family: 'SSO secret backfill CLI',
    reason: 'The SSO secret backfill mutates secrets through raw SQL in a CLI '
      + '(lib/model/sso_secret_backfill.js); secrets never reach rendered output.',
  }),
]);

const bumpCompanies = async ({family, db, payload}) => {
  const companyIds = await family.resolveCompanyIds({db, ...payload});
  if (!companyIds.length) {
    // T-03-06: a wrong or missing resolution over-invalidates nothing and
    // under-invalidates visibly — one red event per unresolved mutation,
    // never a throw, so the committed mutation outcome is unaffected.
    log.error('team_view_invalidation_unresolved', {model: family.model});
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
// excluded audit rows (documentation only) and models that are absent
// (edition families join through the registry when their edition is loaded);
// idempotent per model instance.
const register = ({db}) => {
  if (!db) {
    throw new Error('team_view_invalidation.register requires the model registry');
  }

  for (const family of _families) {
    if (family.excluded) { continue; }
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
