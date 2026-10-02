'use strict';

/*
  MUT-01 tracer slice (create family): a leave booked through POST
  /calendar/bookleave/ keeps the exact success outcome users see today even
  when email delivery keeps failing afterwards; the leave, its comment, and
  the two typed outbox records commit atomically (D-01) and delivery is a
  background concern only (D-02/D-06).

  The app booted by t/lib/http_agent.js does not start schedulers, so
  delivery is driven deterministically with runDeliveryOutboxOnce.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const httpAgent = require('../../lib/http_agent');
const worker = require('../../../lib/scheduler/delivery_outbox_worker');
const deliveryOutbox = require('../../../lib/model/delivery_outbox');

const locale = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'public', 'locales', 'en', 'translation.json'),
  'utf8'
));

// Behavior-compat line: pinned to the exact shipped strings.
const LEAVE_ADDED = locale.calendar.messages.leaveAdded;
const LEAVE_CREATE_FAILED = locale.calendar.messages.leaveCreateFailed;

const SECOND = 1000;
const BEYOND_BACKOFF_CAP_MS = 31 * SECOND;

// Behavior-compat line for the decision families (pinned to the exact
// shipped strings from public/locales/en/translation.json).
const REQUESTS_MESSAGES = locale.requests.messages;
const PROCESSED = REQUESTS_MESSAGES.processed;
const APPROVE_FAILED = REQUESTS_MESSAGES.approveFailed;
const REJECT_FAILED = REQUESTS_MESSAGES.rejectFailed;
const CANCELED = REQUESTS_MESSAGES.canceled;
const CANCEL_FAILED = REQUESTS_MESSAGES.cancelFailed;
const REVOKE_FAILED = REQUESTS_MESSAGES.revokeFailed;
const REVOKE_REQUESTED = REQUESTS_MESSAGES.revokeRequested;
const REVOKE_REQUESTED_NEEDS_APPROVAL = REQUESTS_MESSAGES.revokeRequestedNeedsApproval;
const BULK_NONE_SELECTED = REQUESTS_MESSAGES.bulkNoneSelected;
const BULK_PROCESSED = REQUESTS_MESSAGES.bulkProcessed;
const BULK_FAILED = REQUESTS_MESSAGES.bulkFailed;

// Leave.status_*() values (lib/model/db/leave.js)
const STATUS_NEW = 1;
const STATUS_APPROVED = 2;
const STATUS_REJECTED = 3;
const STATUS_PENDED_REVOKE = 4;
const STATUS_CANCELED = 5;

const fullName = user => user.name + ' ' + user.lastname;

// Resolve the non-failing record type through the real edition registry —
// the same resolution the default worker path uses — so every scenario
// proves the two records of ONE mutation are independent rows: the failing
// type exhausts while the other type still delivers (MUT-03 adjacency).
function executorFailing(failingType) {
  return function(deliveryType) {
    if (deliveryType === failingType) {
      return rejectingExecutor;
    }
    return require('../../../lib/edition').getRegistry().getDeliveryExecutor(deliveryType);
  };
}

function captureLogger() {
  const events = [];
  return {
    events,
    debug : function(message, meta) { events.push({level: 'debug', message, meta}); },
    info  : function(message, meta) { events.push({level: 'info', message, meta}); },
    error : function(message, meta) { events.push({level: 'error', message, meta}); },
  };
}

async function seedCompany(models, label, {autoApprove} = {}) {
  const company = await models.Company.create({
    name: 'Delivery Outcome ' + label, country: 'GB', start_of_new_year: 1,
    date_format: 'YYYY-MM-DD',
  });
  const department = await models.Department.create({
    name: label + ' Department', companyId: company.id,
  });
  const leaveType = await models.LeaveType.create({
    name: label + ' Holiday', companyId: company.id, use_allowance: true,
    auto_approve: !!autoApprove,
  });
  const boss = await models.User.create({
    name: label, lastname: 'Boss', email: label.toLowerCase() + '-boss@test.com',
    password: models.User.hashify_password('test123'), companyId: company.id,
    DepartmentId: department.id, admin: true, activated: true,
  });
  const employee = await models.User.create({
    name: label, lastname: 'Employee', email: label.toLowerCase() + '-user@test.com',
    password: models.User.hashify_password('test123'), companyId: company.id,
    DepartmentId: department.id, activated: true,
  });
  await department.update({bossId: boss.id});

  return {company, department, leaveType, boss, employee};
}

// Seed a leave directly in a chosen status so each family starts from the
// state its route requires (approved for revoke, pended-revoke for the
// revoke-approval path, new for everything else). approverId mirrors
// createNewLeave, which always sets the employee's main supervisor — the
// cancel/decision email executors resolve recipients from it.
async function seedLeaveWithStatus({models, employee, leaveType, status, approverId, fromDate, toDate}) {
  return models.Leave.create({
    userId        : employee.id,
    leaveTypeId   : leaveType.id,
    status,
    approverId,
    date_start    : fromDate,
    date_end      : toDate,
    day_part_start: 1,
    day_part_end  : 1,
  });
}

// Express reads a repeated form key as an array — URLSearchParams built from
// an object would collapse the ids into one comma-joined value, so bulk
// posts are built from [name, value] pairs.
function bulkRequestBody(leaveIds) {
  return new URLSearchParams(leaveIds.map(id => ['request', String(id)]));
}

async function loginAs(user) {
  const agent = await httpAgent.agent();
  await agent.post('/login/').type('form')
    .send({email: user.email, password: 'test123'})
    .expect(302);
  return agent;
}

function bookLeave(agent, {leaveTypeId, fromDate, toDate, reason}) {
  return agent.post('/calendar/bookleave/').type('form').send({
    leave_type     : String(leaveTypeId),
    from_date      : fromDate,
    from_date_part : '1',
    to_date        : toDate,
    to_date_part   : '1',
    reason         : reason || '',
  }).expect(302);
}

async function driveSweeps({models, logger, resolveExecutor, sweeps, startAt}) {
  const results = [];
  let clock = new Date(startAt.getTime());

  for (let i = 0; i < sweeps; i += 1) {
    results.push(await worker.runDeliveryOutboxOnce({
      models, logger, now: clock, resolveExecutor,
    }));
    clock = new Date(clock.getTime() + BEYOND_BACKOFF_CAP_MS);
  }

  return results;
}

const rejectingExecutor = {
  deliver: function() {
    return Promise.reject(new Error('synthetic smtp outage'));
  },
};

const requestsRouteSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'lib', 'route', 'requests.js'),
  'utf8'
);

describe('Decision routes delivery-outcome source contract', function() {

  it('contains no in-request email invocation tokens (MUT-01)', function() {
    expect(
      (requestsRouteSource.match(/promise_leave_request/g) || []).length,
      'lib/route/requests.js still invokes leave email promises in-request'
    ).to.equal(0);
  });

  it('contains no in-request edition event dispatch tokens (MUT-01)', function() {
    expect(
      (requestsRouteSource.match(/dispatchLeaveEvent/g) || []).length,
      'lib/route/requests.js still dispatches edition leave events in-request'
    ).to.equal(0);
  });

  it('constructs no email transport (MUT-01)', function() {
    expect(
      (requestsRouteSource.match(/EmailTransport/g) || []).length,
      'lib/route/requests.js still constructs an email transport'
    ).to.equal(0);
  });
});

describe('Leave create delivery outcome (MUT-01 tracer)', function() {

  this.timeout(30000);

  let models;
  let fixturesA;
  let fixturesB;
  let fixturesC;

  before(async function() {
    await httpAgent.ready();
    models = httpAgent.getApp().get('db_model');

    fixturesA = await seedCompany(models, 'TracerA');
    fixturesB = await seedCompany(models, 'TracerB');
    fixturesC = await seedCompany(models, 'TracerC');
  });

  after(async function() {
    if (!models) {
      return;
    }
    [fixturesA, fixturesB, fixturesC].forEach(function(fixtures) {
      if (!fixtures) {
        return;
      }
      models.DeliveryOutbox.destroy({where: {companyId: fixtures.company.id}});
      models.Leave.destroy({where: {userId: fixtures.employee.id}});
      models.Comment.destroy({where: {companyId: fixtures.company.id}});
    });
    await models.User.destroy({where: {
      id: {[models.Sequelize.Op.in]: [fixturesA, fixturesB, fixturesC]
        .filter(Boolean)
        .reduce((ids, fixtures) => ids.concat([fixtures.boss.id, fixtures.employee.id]), [])},
    }});
    [fixturesA, fixturesB, fixturesC].forEach(function(fixtures) {
      if (!fixtures) {
        return;
      }
      models.LeaveType.destroy({where: {id: fixtures.leaveType.id}});
      models.Department.destroy({where: {id: fixtures.department.id}});
    });
    await models.Company.destroy({where: {
      id: {[models.Sequelize.Op.in]: [fixturesA.company.id, fixturesB.company.id, fixturesC.company.id]},
    }});
    await httpAgent.release();
  });

  it('pins the exact behavior-compat strings from the locale bundle', function() {
    expect(LEAVE_ADDED).to.equal('New leave request was added');
    expect(LEAVE_CREATE_FAILED).to.equal('Failed to create a leave request');
  });

  it('Scenario A: failing email never flips the create outcome; delivery exhausts in background (MUT-01/D-03/D-06)', async function() {
    const agent = await loginAs(fixturesA.employee);

    const response = await bookLeave(agent, {
      leaveTypeId : fixturesA.leaveType.id,
      fromDate    : '2030-12-01',
      toDate      : '2030-12-02',
      reason      : 'tracer scenario a',
    });

    // Exact success outcome, byte-identical key and redirect shape
    expect(response.headers.location).to.contain('..');

    const calendarPage = await agent.get('/calendar/').expect(200);
    expect(calendarPage.text).to.contain(LEAVE_ADDED);
    expect(calendarPage.text.toLowerCase()).to.not.contain('deliver');
    expect(calendarPage.text.toLowerCase()).to.not.contain('retry');

    // The leave and its comment are committed; the outbox holds the two
    // typed pending records (D-01 + D-09)
    const committedLeave = await models.Leave.findOne({
      where: {userId: fixturesA.employee.id},
    });
    expect(committedLeave).to.not.equal(null);
    expect(await models.Comment.count({
      where: {companyId: fixturesA.company.id, comment: 'tracer scenario a'},
    })).to.equal(1);

    const outboxRows = await models.DeliveryOutbox.findAll({
      where: {companyId: fixturesA.company.id},
    });
    expect(outboxRows.length).to.equal(2);
    expect(outboxRows.map(row => row.deliveryType).sort())
      .to.deep.equal(['edition_event', 'email']);
    outboxRows.forEach(function(row) {
      expect(row.status).to.equal('pending');
      expect(row.attempts).to.equal(0);
      expect(row.eventType).to.equal('submitted');
      expect(JSON.parse(row.payload)).to.deep.equal({leaveId: committedLeave.id});
    });

    // Background exhaustion with a permanently failing executor: exactly 5
    // attempts, terminal failed, one red delivery_exhausted event
    const logger = captureLogger();
    const results = await driveSweeps({
      models,
      logger,
      resolveExecutor : () => rejectingExecutor,
      sweeps          : 5,
      startAt         : new Date(),
    });
    results.forEach(function(result) {
      expect(result.skipped).to.equal(false);
    });

    const rows = await models.DeliveryOutbox.findAll({
      where: {companyId: fixturesA.company.id},
    });
    const emailRow = rows.find(row => row.deliveryType === 'email');
    expect(emailRow.status).to.equal('failed');
    expect(emailRow.attempts).to.equal(5);

    const exhausted = logger.events.filter(event => event.message === 'delivery_exhausted');
    expect(exhausted.length).to.be.at.least(1);
    expect(exhausted[0].meta.type).to.equal('email');
    expect(exhausted[0].meta.attempts).to.equal(5);

    // A later sweep (pending-only tick) never re-touches the terminal record
    await driveSweeps({
      models,
      logger          : captureLogger(),
      resolveExecutor : () => rejectingExecutor,
      sweeps          : 1,
      startAt         : new Date(Date.now() + BEYOND_BACKOFF_CAP_MS),
    });
    await emailRow.reload();
    expect(emailRow.attempts).to.equal(5);

    // And the committed mutation plus its user outcome are unchanged
    expect(await models.Leave.count({where: {userId: fixturesA.employee.id}})).to.equal(1);
    const calendarAfter = await agent.get('/calendar/').expect(200);
    expect(calendarAfter.text).to.not.contain(LEAVE_CREATE_FAILED);
  });

  it('Scenario B: pretend-send default contour delivers through the same worker path (Pitfall 8)', async function() {
    const agent = await loginAs(fixturesB.employee);

    await bookLeave(agent, {
      leaveTypeId : fixturesB.leaveType.id,
      fromDate    : '2030-11-03',
      toDate      : '2030-11-04',
    });

    expect(await models.DeliveryOutbox.count({
      where: {companyId: fixturesB.company.id, status: 'pending'},
    })).to.equal(2);

    // Default executor resolution: the real community executors through the
    // edition registry. send_emails=false in the test contour, so the email
    // facade pretend-sends and resolves — one code path for all contours.
    const logger = captureLogger();
    const result = await worker.runDeliveryOutboxOnce({models, logger});

    expect(result.skipped).to.equal(false);

    const rows = await models.DeliveryOutbox.findAll({
      where: {companyId: fixturesB.company.id},
    });
    expect(rows.length).to.equal(2);
    rows.forEach(function(row) {
      expect(row.status, row.deliveryType + ' record').to.equal('delivered');
      expect(row.deliveredAt).to.be.an.instanceOf(Date);
    });
  });

  it('Scenario C: a forced in-transaction failure leaves no leave, comment, or outbox rows (D-01, Pitfall 2)', async function() {
    const agent = await loginAs(fixturesC.employee);

    const originalEnqueue = deliveryOutbox.enqueue;
    deliveryOutbox.enqueue = function() {
      return Promise.reject(new Error('synthetic enqueue failure'));
    };

    let response;
    try {
      response = await bookLeave(agent, {
        leaveTypeId : fixturesC.leaveType.id,
        fromDate    : '2030-10-06',
        toDate      : '2030-10-07',
        reason      : 'tracer scenario c',
      });
    } finally {
      deliveryOutbox.enqueue = originalEnqueue;
    }

    expect(response.headers.location).to.contain('..');

    const calendarPage = await agent.get('/calendar/').expect(200);
    expect(calendarPage.text).to.contain(LEAVE_CREATE_FAILED);

    // Atomic rollback: nothing from the aborted unit survives
    expect(await models.Leave.count({where: {userId: fixturesC.employee.id}})).to.equal(0);
    expect(await models.Comment.count({where: {companyId: fixturesC.company.id}})).to.equal(0);
    expect(await models.DeliveryOutbox.count({where: {companyId: fixturesC.company.id}})).to.equal(0);
  });
});

/*
  The full decision-family matrix (MUT-01/MUT-02): approve, reject, cancel,
  both revoke variants, and both bulk variants each keep the exact success
  outcome users see today while one record type of their mutation fails
  permanently in the background — first the email record, then in a second
  pass the edition_event record. Bulk counting is commit-only (D-07), and a
  failure inside a decision transaction rolls the whole unit back (Pitfall 2).

  The create contour above is the matrix's first entry; this describe adds
  the six decision families on top of it.
*/
describe('Decision families delivery outcome (MUT-01/MUT-02 matrix)', function() {

  this.timeout(60000);

  let models;
  const seededFixtures = [];

  before(async function() {
    await httpAgent.ready();
    models = httpAgent.getApp().get('db_model');
  });

  after(async function() {
    if (!models) {
      return;
    }
    for (const fixtures of seededFixtures.filter(Boolean)) {
      await models.DeliveryOutbox.destroy({where: {companyId: fixtures.company.id}});
      await models.Leave.destroy({where: {userId: fixtures.employee.id}});
      await models.User.destroy({where: {id: [fixtures.boss.id, fixtures.employee.id]}});
      await models.LeaveType.destroy({where: {id: fixtures.leaveType.id}});
      await models.Department.destroy({where: {id: fixtures.department.id}});
      await models.Company.destroy({where: {id: fixtures.company.id}});
    }
    await httpAgent.release();
  });

  it('pins the exact decision-family behavior-compat strings from the locale bundle', function() {
    expect(PROCESSED).to.equal('Request from {{name}} was processed');
    expect(BULK_PROCESSED).to.equal('{{count}} request(s) were processed ({{action}}).');
    expect(BULK_FAILED).to.equal('{{count}} request(s) could not be processed.');
    expect(CANCELED).to.equal('The leave request was canceled');
    expect(REVOKE_REQUESTED).to.equal('You have requested leave to be revoked.');
    expect(REVOKE_REQUESTED_NEEDS_APPROVAL)
      .to.equal('You have requested leave to be revoked. Your supervisor needs to approve it.');
  });

  // One truthfulness scenario: act over HTTP, prove the committed state and
  // the two typed outbox rows, prove the user surface shows only the exact
  // success outcome, then exhaust the failing record type in the background
  // and prove the other record type still delivered and the user outcome is
  // unchanged (MUT-02: delivery state never reaches the user surface).
  async function assertTruthfulOutcome({
    fixtures, actor, response, leaves, expectedStatuses, eventType, mutationCount,
    expectedFlash, failureFlash, failingType, emailPayloadKind,
  }) {
    const location = response.headers.location || '';
    expect(location.toLowerCase()).to.not.contain('deliver');
    expect(location.toLowerCase()).to.not.contain('retry');

    const committed = await Promise.all(leaves.map(leave => leave.reload()));
    committed.forEach(function(leave, index) {
      expect(leave.status, 'leave ' + leave.id + ' status').to.equal(expectedStatuses[index]);
    });

    const rows = await models.DeliveryOutbox.findAll({
      where: {companyId: fixtures.company.id},
    });
    expect(rows.length).to.equal(2 * mutationCount);
    rows.forEach(function(row) {
      expect(row.status).to.equal('pending');
      expect(row.attempts).to.equal(0);
      expect(row.eventType).to.equal(eventType);
      expect(row.companyId).to.equal(fixtures.company.id);
    });
    rows.filter(row => row.deliveryType === 'email').forEach(function(row) {
      const parsed = JSON.parse(row.payload);
      if (emailPayloadKind === 'reference') {
        expect(parsed).to.deep.equal({leaveId: parsed.leaveId});
      } else {
        expect(parsed).to.deep.equal({
          leaveId         : parsed.leaveId,
          action          : eventType,
          wasPendedRevoke : emailPayloadKind === 'pended',
        });
      }
    });
    rows.filter(row => row.deliveryType === 'edition_event').forEach(function(row) {
      expect(JSON.parse(row.payload)).to.deep.equal({leaveId: JSON.parse(row.payload).leaveId});
    });

    const page = await actor.get('/requests/').expect(200);
    expect(page.text).to.contain(expectedFlash);
    expect(page.text).to.not.contain(failureFlash);
    expect(page.text.toLowerCase()).to.not.contain('deliver');
    expect(page.text.toLowerCase()).to.not.contain('retry');

    const logger = captureLogger();
    const results = await driveSweeps({
      models,
      logger,
      resolveExecutor : executorFailing(failingType),
      sweeps          : 5,
      startAt         : new Date(),
    });
    results.forEach(function(result) {
      expect(result.skipped).to.equal(false);
    });

    const afterRows = await models.DeliveryOutbox.findAll({
      where: {companyId: fixtures.company.id},
    });
    const failingRows = afterRows.filter(row => row.deliveryType === failingType);
    const independentRows = afterRows.filter(row => row.deliveryType !== failingType);
    expect(failingRows.length).to.equal(mutationCount);
    failingRows.forEach(function(row) {
      expect(row.status, failingType + ' record is terminally failed').to.equal('failed');
      expect(row.attempts).to.equal(5);
    });
    independentRows.forEach(function(row) {
      expect(row.status, 'the other record type of the same mutation delivered').to.equal('delivered');
    });
    expect(logger.events.filter(event => event.message === 'delivery_exhausted').length)
      .to.equal(mutationCount);

    const pageAfterExhaustion = await actor.get('/requests/').expect(200);
    expect(pageAfterExhaustion.text).to.not.contain(failureFlash);
    expect(pageAfterExhaustion.text.toLowerCase()).to.not.contain('deliver');
    const stillCommitted = await Promise.all(leaves.map(leave => leave.reload()));
    stillCommitted.forEach(function(leave, index) {
      expect(leave.status).to.equal(expectedStatuses[index]);
    });
  }

  const families = [
    {
      key             : 'apv',
      name            : 'single approve',
      actor           : 'boss',
      seedStatuses    : [STATUS_NEW],
      expectedStatuses: [STATUS_APPROVED],
      eventType       : 'approve',
      emailPayloadKind: 'decision',
      failureFlash    : APPROVE_FAILED,
      flashFor        : fixtures => PROCESSED.replace('{{name}}', fullName(fixtures.employee)),
      redirect        : 'relative',
      act             : (agent, leaves) => agent.post('/requests/approve/').type('form')
        .send({request: String(leaves[0].id)}).expect(302),
    },
    {
      key             : 'rej',
      name            : 'single reject',
      actor           : 'boss',
      seedStatuses    : [STATUS_NEW],
      expectedStatuses: [STATUS_REJECTED],
      eventType       : 'reject',
      emailPayloadKind: 'decision',
      failureFlash    : REJECT_FAILED,
      flashFor        : fixtures => PROCESSED.replace('{{name}}', fullName(fixtures.employee)),
      redirect        : 'relative',
      act             : (agent, leaves) => agent.post('/requests/reject/').type('form')
        .send({request: String(leaves[0].id)}).expect(302),
    },
    {
      key             : 'pdr',
      name            : 'approve of a pended-revoke leave',
      actor           : 'boss',
      seedStatuses    : [STATUS_PENDED_REVOKE],
      expectedStatuses: [STATUS_REJECTED],
      eventType       : 'approve',
      emailPayloadKind: 'pended',
      failureFlash    : APPROVE_FAILED,
      flashFor        : fixtures => PROCESSED.replace('{{name}}', fullName(fixtures.employee)),
      redirect        : 'relative',
      act             : (agent, leaves) => agent.post('/requests/approve/').type('form')
        .send({request: String(leaves[0].id)}).expect(302),
    },
    {
      key             : 'can',
      name            : 'cancel',
      actor           : 'employee',
      seedStatuses    : [STATUS_NEW],
      expectedStatuses: [STATUS_CANCELED],
      eventType       : 'cancel',
      emailPayloadKind: 'reference',
      failureFlash    : CANCEL_FAILED,
      flashFor        : () => CANCELED,
      redirect        : 'requests-page',
      act             : (agent, leaves) => agent.post('/requests/cancel/').type('form')
        .send({request: String(leaves[0].id)}).expect(302),
    },
    {
      key             : 'rvk',
      name            : 'revoke needing approval',
      actor           : 'employee',
      seedStatuses    : [STATUS_APPROVED],
      expectedStatuses: [STATUS_PENDED_REVOKE],
      eventType       : 'revoke',
      emailPayloadKind: 'reference',
      failureFlash    : REVOKE_FAILED,
      flashFor        : () => REVOKE_REQUESTED_NEEDS_APPROVAL,
      redirect        : 'relative',
      act             : (agent, leaves) => agent.post('/requests/revoke/').type('form')
        .send({request: String(leaves[0].id)}).expect(302),
    },
    {
      key             : 'rva',
      name            : 'revoke of an auto-approving leave type',
      actor           : 'employee',
      seedStatuses    : [STATUS_APPROVED],
      seedOptions     : {autoApprove: true},
      expectedStatuses: [STATUS_REJECTED],
      eventType       : 'revoke',
      emailPayloadKind: 'reference',
      failureFlash    : REVOKE_FAILED,
      flashFor        : () => REVOKE_REQUESTED,
      redirect        : 'relative',
      act             : (agent, leaves) => agent.post('/requests/revoke/').type('form')
        .send({request: String(leaves[0].id)}).expect(302),
    },
    {
      key             : 'bap',
      name            : 'bulk approve of two leaves',
      actor           : 'boss',
      seedStatuses    : [STATUS_NEW, STATUS_NEW],
      expectedStatuses: [STATUS_APPROVED, STATUS_APPROVED],
      eventType       : 'approve',
      emailPayloadKind: 'decision',
      failureFlash    : BULK_FAILED.replace('{{count}}', '2'),
      flashFor        : () => BULK_PROCESSED.replace('{{count}}', '2')
        .replace('{{action}}', locale.requests.approve),
      redirect        : 'requests-page',
      act             : (agent, leaves) => agent.post('/requests/bulk/approve/').type('form')
        .send(bulkRequestBody(leaves.map(leave => leave.id))).expect(302),
    },
    {
      key             : 'brj',
      name            : 'bulk reject of two leaves',
      actor           : 'boss',
      seedStatuses    : [STATUS_NEW, STATUS_NEW],
      expectedStatuses: [STATUS_REJECTED, STATUS_REJECTED],
      eventType       : 'reject',
      emailPayloadKind: 'decision',
      failureFlash    : BULK_FAILED.replace('{{count}}', '2'),
      flashFor        : () => BULK_PROCESSED.replace('{{count}}', '2')
        .replace('{{action}}', locale.requests.reject),
      redirect        : 'requests-page',
      act             : (agent, leaves) => agent.post('/requests/bulk/reject/').type('form')
        .send(bulkRequestBody(leaves.map(leave => leave.id))).expect(302),
    },
  ];

  families.forEach(function(family) {
    ['email', 'edition_event'].forEach(function(failingType) {

      it('keeps the exact success outcome for ' + family.name
        + ' while the ' + failingType + ' record fails permanently', async function() {

        const label = family.key + (failingType === 'email' ? 'E' : 'V');
        const fixtures = await seedCompany(models, label, family.seedOptions);
        seededFixtures.push(fixtures);

        const leaves = [];
        for (let i = 0; i < family.seedStatuses.length; i += 1) {
          const month = 2 + i; // one distinct month per seeded leave
          leaves.push(await seedLeaveWithStatus({
            models,
            employee  : fixtures.employee,
            leaveType : fixtures.leaveType,
            status    : family.seedStatuses[i],
            approverId: fixtures.boss.id,
            fromDate  : '2031-0' + month + '-12',
            toDate    : '2031-0' + month + '-13',
          }));
        }

        const actor = await loginAs(family.actor === 'boss' ? fixtures.boss : fixtures.employee);

        const response = await family.act(actor, leaves);
        if (family.redirect === 'requests-page') {
          expect(response.headers.location).to.equal('/requests/');
        } else {
          expect(response.headers.location).to.contain('..');
        }

        await assertTruthfulOutcome({
          fixtures,
          actor,
          response,
          leaves,
          expectedStatuses : family.expectedStatuses,
          eventType        : family.eventType,
          mutationCount    : family.seedStatuses.length,
          expectedFlash    : family.flashFor(fixtures),
          failureFlash     : family.failureFlash,
          failingType,
          emailPayloadKind : family.emailPayloadKind,
        });
      });
    });
  });

  it('bulk counts stay commit-truthful when one item rolls back (D-07, Pitfall 12)', async function() {
    const fixtures = await seedCompany(models, 'Mbrk');
    seededFixtures.push(fixtures);

    const leaveA = await seedLeaveWithStatus({
      models, employee: fixtures.employee, leaveType: fixtures.leaveType,
      status: STATUS_NEW, approverId: fixtures.boss.id,
      fromDate: '2031-05-11', toDate: '2031-05-12',
    });
    const leaveB = await seedLeaveWithStatus({
      models, employee: fixtures.employee, leaveType: fixtures.leaveType,
      status: STATUS_NEW, approverId: fixtures.boss.id,
      fromDate: '2031-06-11', toDate: '2031-06-12',
    });

    const agent = await loginAs(fixtures.boss);

    // Force the SECOND item's transaction to fail at enqueue time: the
    // enqueue is inside the item's commit unit, so the leave change and the
    // outbox rows roll back together and the item legitimately counts as
    // failed (Pitfall 12).
    const originalEnqueue = deliveryOutbox.enqueue;
    deliveryOutbox.enqueue = function(args) {
      const blocked = (args.records || []).some(function(record) {
        return record.payload && record.payload.leaveId === leaveB.id;
      });
      if (blocked) {
        return Promise.reject(new Error('synthetic enqueue failure'));
      }
      return originalEnqueue.call(deliveryOutbox, args);
    };

    let response;
    try {
      response = await agent.post('/requests/bulk/approve/').type('form')
        .send(bulkRequestBody([leaveA.id, leaveB.id])).expect(302);
    } finally {
      deliveryOutbox.enqueue = originalEnqueue;
    }

    expect(response.headers.location).to.equal('/requests/');

    const page = await agent.get('/requests/').expect(200);
    expect(page.text).to.contain(BULK_PROCESSED.replace('{{count}}', '1')
      .replace('{{action}}', locale.requests.approve));
    expect(page.text).to.contain(BULK_FAILED.replace('{{count}}', '1'));
    expect(page.text.toLowerCase()).to.not.contain('deliver');

    await leaveA.reload();
    await leaveB.reload();
    expect(leaveA.status).to.equal(STATUS_APPROVED);
    expect(leaveB.status, 'the rolled-back item keeps its pre-decision status').to.equal(STATUS_NEW);

    const rows = await models.DeliveryOutbox.findAll({
      where: {companyId: fixtures.company.id},
    });
    expect(rows.length, 'only the committed item left outbox rows').to.equal(2);
    rows.forEach(function(row) {
      expect(JSON.parse(row.payload).leaveId).to.equal(leaveA.id);
    });

    // Deliver the committed item's rows so later scenarios' sweeps stay
    // scoped to their own companies.
    await worker.runDeliveryOutboxOnce({models, logger: captureLogger()});
  });

  it('empty bulk selection keeps the zero-count outcome; a single-item bulk behaves as the family', async function() {
    const fixtures = await seedCompany(models, 'Memp');
    seededFixtures.push(fixtures);

    const leave = await seedLeaveWithStatus({
      models, employee: fixtures.employee, leaveType: fixtures.leaveType,
      status: STATUS_NEW, approverId: fixtures.boss.id,
      fromDate: '2031-07-12', toDate: '2031-07-13',
    });

    const agent = await loginAs(fixtures.boss);

    const emptyResponse = await agent.post('/requests/bulk/approve/').type('form')
      .send({}).expect(302);
    expect(emptyResponse.headers.location).to.equal('/requests/');

    const emptyPage = await agent.get('/requests/').expect(200);
    expect(emptyPage.text).to.contain(BULK_NONE_SELECTED);
    expect(emptyPage.text).to.not.contain('request(s) were processed');
    await leave.reload();
    expect(leave.status).to.equal(STATUS_NEW);
    expect(await models.DeliveryOutbox.count({where: {companyId: fixtures.company.id}})).to.equal(0);

    // A scalar checkbox value (single selection) is normalised to one item.
    const singleResponse = await agent.post('/requests/bulk/approve/').type('form')
      .send({request: String(leave.id)}).expect(302);
    expect(singleResponse.headers.location).to.equal('/requests/');

    const singlePage = await agent.get('/requests/').expect(200);
    expect(singlePage.text).to.contain(BULK_PROCESSED.replace('{{count}}', '1')
      .replace('{{action}}', locale.requests.approve));
    await leave.reload();
    expect(leave.status).to.equal(STATUS_APPROVED);
    expect(await models.DeliveryOutbox.count({where: {companyId: fixtures.company.id}})).to.equal(2);

    await worker.runDeliveryOutboxOnce({models, logger: captureLogger()});
  });

  it('a failure inside a decision transaction rolls the leave change and its outbox rows back (Pitfall 2)', async function() {
    const fixtures = await seedCompany(models, 'Matm');
    seededFixtures.push(fixtures);

    const leave = await seedLeaveWithStatus({
      models, employee: fixtures.employee, leaveType: fixtures.leaveType,
      status: STATUS_NEW, approverId: fixtures.boss.id,
      fromDate: '2031-08-12', toDate: '2031-08-13',
    });

    const agent = await loginAs(fixtures.boss);

    const originalEnqueue = deliveryOutbox.enqueue;
    deliveryOutbox.enqueue = function() {
      return Promise.reject(new Error('synthetic enqueue failure'));
    };

    let response;
    try {
      response = await agent.post('/requests/approve/').type('form')
        .send({request: String(leave.id)}).expect(302);
    } finally {
      deliveryOutbox.enqueue = originalEnqueue;
    }

    expect(response.headers.location).to.contain('..');

    const page = await agent.get('/requests/').expect(200);
    expect(page.text).to.contain(APPROVE_FAILED);

    await leave.reload();
    expect(leave.status, 'the leave keeps its pre-decision status').to.equal(STATUS_NEW);
    expect(await models.DeliveryOutbox.count({where: {companyId: fixtures.company.id}}))
      .to.equal(0);
  });
});
