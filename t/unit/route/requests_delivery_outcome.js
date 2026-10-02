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

function captureLogger() {
  const events = [];
  return {
    events,
    debug : function(message, meta) { events.push({level: 'debug', message, meta}); },
    info  : function(message, meta) { events.push({level: 'info', message, meta}); },
    error : function(message, meta) { events.push({level: 'error', message, meta}); },
  };
}

async function seedCompany(models, label) {
  const company = await models.Company.create({
    name: 'Delivery Outcome ' + label, country: 'GB', start_of_new_year: 1,
    date_format: 'YYYY-MM-DD',
  });
  const department = await models.Department.create({
    name: label + ' Department', companyId: company.id,
  });
  const leaveType = await models.LeaveType.create({
    name: label + ' Holiday', companyId: company.id, use_allowance: true,
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
