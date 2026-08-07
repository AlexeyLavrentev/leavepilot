'use strict';

/*
  validate_overlapping asks the database for leaves that could clash with the
  requested dates, and asked the wrong question:

    date_start BETWEEN from_date AND to_date + 1
    OR
    date_end   BETWEEN from_date AND to_date + 1

  That finds a leave with an *endpoint* inside the requested window. A leave
  that starts before it and ends after it has neither, so an approved holiday
  of 2 - 20 March did not stand in the way of booking 10 - 12 March. Both were
  stored, both painted the calendar, the team view and the reports, and with a
  leave type that uses allowance the same days were deducted twice.

  The predicate that means "these two intervals overlap" is the closed-interval
  one, and it is already spelled out in lib/model/leave/index.js:155 for the
  critical-overlap check and in lib/model/Report.js for report filtering:

    date_start <= to_date AND date_end >= from_date

  The second half of the bug is the answer being read: only overlapping_leaves[0]
  was offered to fit_with_leave_request, so with more than one candidate a first
  one that fits - the half-day handover below - hid whatever came after it.

  Written against the real models rather than a stubbed getMy_leaves, because
  the defect is the query. Dates are pinned in 2030 so the clock cannot decide
  what this suite means.
*/

const expect = require('chai').expect;
const httpAgent = require('../lib/http_agent');
const LeaveRequestParameters = require('../../lib/model/leave_request_parameters');

describe('Overlapping leave validation', function() {

  this.timeout(30000);

  let models;
  let company;
  let department;
  let user;
  let leaveType;

  const request = (from, to, parts) => new LeaveRequestParameters(Object.assign({
    leave_type     : leaveType,
    user           : user,
    reason         : 'overlap validation',
    from_date      : from,
    to_date        : to,
    from_date_part : 1,
    to_date_part   : 1,
  }, parts || {}));

  const book = async (from, to, status, parts) => {
    const leave = await models.Leave.create({
      userId        : user.id,
      leaveTypeId   : leaveType.id,
      date_start    : from,
      date_end      : to,
      day_part_start: (parts && parts.start) || 1,
      day_part_end  : (parts && parts.end) || 1,
      status        : status === undefined ? models.Leave.status_approved() : status,
    });

    return leave;
  };

  const clearLeaves = () => models.Leave.destroy({where: {userId: user.id}});

  // Reports whether the request was refused, without making every case a
  // try/catch at the call site.
  const refused = async (leaveRequest) => {
    try {
      await user.validate_overlapping(leaveRequest);
      return false;
    } catch (error) {
      expect(error.user_message, 'refused with an unexpected error: ' + error.message)
        .to.be.a('string');
      return true;
    }
  };

  before(async function() {
    await httpAgent.ready();
    models = httpAgent.getApp().get('db_model');

    company = await models.Company.create({
      name: 'Overlap Validation Company', country: 'GB', start_of_new_year: 1,
    });
    department = await models.Department.create({
      name: 'Overlap Validation Department', companyId: company.id,
    });
    leaveType = await models.LeaveType.create({
      name: 'Overlap Holiday', companyId: company.id, use_allowance: true,
    });
    user = await models.User.create({
      name: 'Overlap', lastname: 'Employee', email: 'overlap-validation@test.com',
      password: models.User.hashify_password('test123'), companyId: company.id,
      DepartmentId: department.id, activated: true,
    });
  });

  after(async function() {
    if (models) {
      await models.Leave.destroy({where: {userId: user.id}});
      await models.User.destroy({where: {id: user.id}});
      await models.LeaveType.destroy({where: {id: leaveType.id}});
      await models.Department.destroy({where: {id: department.id}});
      await models.Company.destroy({where: {id: company.id}});
    }
    await httpAgent.release();
  });

  afterEach(async function() {
    await clearLeaves();
  });

  describe('an existing leave that contains the request', function() {

    it('refuses a request sitting inside it', async function() {
      await book('2030-03-02', '2030-03-20');

      expect(await refused(request('2030-03-10', '2030-03-12'))).to.equal(
        true,
        'a leave inside an existing one was accepted, so the days are booked twice'
      );
    });

    it('refuses a single day inside it', async function() {
      await book('2030-03-02', '2030-03-20');

      expect(await refused(request('2030-03-11', '2030-03-11'))).to.equal(true);
    });

    // The mirror image: the request contains the existing leave. This one was
    // caught before, since both of its endpoints fall inside the window.
    it('refuses a request that swallows an existing leave', async function() {
      await book('2030-03-10', '2030-03-12');

      expect(await refused(request('2030-03-02', '2030-03-20'))).to.equal(true);
    });
  });

  describe('the overlaps that were already caught', function() {

    it('refuses one that starts inside an existing leave', async function() {
      await book('2030-04-01', '2030-04-10');

      expect(await refused(request('2030-04-05', '2030-04-15'))).to.equal(true);
    });

    it('refuses one that ends inside an existing leave', async function() {
      await book('2030-04-10', '2030-04-20');

      expect(await refused(request('2030-04-05', '2030-04-15'))).to.equal(true);
    });

    it('refuses one sharing a single boundary day', async function() {
      await book('2030-04-10', '2030-04-20');

      expect(await refused(request('2030-04-20', '2030-04-25'))).to.equal(true);
    });
  });

  describe('what it must still allow', function() {

    it('allows a request before an existing leave', async function() {
      await book('2030-05-10', '2030-05-20');

      expect(await refused(request('2030-05-01', '2030-05-09'))).to.equal(false);
    });

    it('allows a request after an existing leave', async function() {
      await book('2030-05-10', '2030-05-20');

      expect(await refused(request('2030-05-21', '2030-05-30'))).to.equal(false);
    });

    /*
      The half-day handover: an existing leave ending on the morning of the
      20th does not block a request starting that same afternoon. This is what
      fit_with_leave_request is for, and widening the query must not cost it.
    */
    it('allows an afternoon request on the day an existing leave ends in the morning', async function() {
      await book('2030-06-10', '2030-06-20', undefined, {end: 2});

      expect(await refused(request(
        '2030-06-20', '2030-06-25', {from_date_part: 3}
      ))).to.equal(false);
    });

    it('allows a morning request on the day an existing leave starts in the afternoon', async function() {
      await book('2030-06-20', '2030-06-30', undefined, {start: 3});

      expect(await refused(request(
        '2030-06-15', '2030-06-20', {to_date_part: 2}
      ))).to.equal(false);
    });

    it('ignores a rejected leave', async function() {
      await book('2030-07-10', '2030-07-20', models.Leave.status_rejected());

      expect(await refused(request('2030-07-12', '2030-07-15'))).to.equal(false);
    });

    it('ignores a cancelled leave', async function() {
      await book('2030-07-10', '2030-07-20', models.Leave.status_canceled());

      expect(await refused(request('2030-07-12', '2030-07-15'))).to.equal(false);
    });
  });

  /*
    Only the first candidate was ever offered to fit_with_leave_request. With a
    half-day handover sorted ahead of a real clash, the clash was never looked
    at - so the fix has to consider every candidate, not just the widened query.
  */
  describe('when more than one existing leave is in range', function() {

    it('refuses a request that fits the first and clashes with the second', async function() {
      await book('2030-08-01', '2030-08-10', undefined, {end: 2});
      await book('2030-08-14', '2030-08-20');

      expect(await refused(request('2030-08-10', '2030-08-16', {from_date_part: 3}))).to.equal(
        true,
        'the half-day handover with the first leave hid the clash with the second'
      );
    });

    it('still allows a request that fits every one of them', async function() {
      await book('2030-09-01', '2030-09-10', undefined, {end: 2});
      await book('2030-09-20', '2030-09-30');

      expect(await refused(request('2030-09-10', '2030-09-15', {from_date_part: 3}))).to.equal(false);
    });
  });
});
