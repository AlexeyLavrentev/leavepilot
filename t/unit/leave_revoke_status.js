'use strict';

/*
  The revoke handler carries this comment:

    // Ensure that Leave is in status from it could be revoked
    if (! leave_to_process) {

  and the line under it checks that the leave exists and belongs to someone the
  caller may act for. Nothing checked the status, and promise_to_revoke did not
  either - unlike promise_to_cancel beside it, which refuses anything that is
  not a new request.

  So a POST to /requests/revoke/ carrying the id of the caller's own *rejected*
  leave moved it to pended-revoke. That status counts as approved:

    Leave.prototype.is_approved_leave = function() {
      return this.status === Leave.status_approved() ||
        this.status === Leave.status_pended_revoke();
    };

  which means the rejected leave started deducting allowance again, painting the
  calendar and the team view, and sitting in the approver's queue. And if the
  approver pressed Reject there, promise_to_reject reads the same status the
  other way round:

    self.status = self.is_pended_revoke_leave() ?
      Leave.status_approved() : Leave.status_rejected();

  and the leave the manager had already refused became Approved.

  No button renders for it - views/partials/user_requests.hbs offers revoke only
  while a leave is approved and not already pending revoke - so this takes a
  hand-made POST with the caller's own CSRF token, and the bogus state is
  visible to the approver. That is why it is a hole worth closing rather than an
  emergency.

  The guard is the view's own condition, written with the same two helpers, so
  the button and the route agree on what may be revoked.
*/

const expect = require('chai').expect;
const httpAgent = require('../lib/http_agent');

describe('Revoking a leave', function() {

  this.timeout(30000);

  let models;
  let company;
  let department;
  let boss;
  let employee;
  let leaveType;

  const book = async (status, options) => models.Leave.create(Object.assign({
    userId        : employee.id,
    leaveTypeId   : leaveType.id,
    date_start    : '2030-04-10',
    date_end      : '2030-04-12',
    day_part_start: 1,
    day_part_end  : 1,
    status        : status,
  }, options || {}));

  const revoking = async (leave) => {
    try {
      await leave.promise_to_revoke();
      return null;
    } catch (error) {
      return error;
    }
  };

  before(async function() {
    await httpAgent.ready();
    models = httpAgent.getApp().get('db_model');

    company = await models.Company.create({
      name: 'Revoke Status Company', country: 'GB', start_of_new_year: 1,
    });
    department = await models.Department.create({
      name: 'Revoke Status Department', companyId: company.id,
    });
    leaveType = await models.LeaveType.create({
      name: 'Revoke Holiday', companyId: company.id, use_allowance: true,
    });
    boss = await models.User.create({
      name: 'Revoke', lastname: 'Boss', email: 'revoke-status-boss@test.com',
      password: models.User.hashify_password('test123'), companyId: company.id,
      DepartmentId: department.id, admin: true, activated: true,
    });
    employee = await models.User.create({
      name: 'Revoke', lastname: 'Employee', email: 'revoke-status-user@test.com',
      password: models.User.hashify_password('test123'), companyId: company.id,
      DepartmentId: department.id, activated: true,
    });
    await department.update({bossId: boss.id});
  });

  after(async function() {
    if (models) {
      await models.Leave.destroy({where: {userId: employee.id}});
      await models.User.destroy({where: {id: {[models.Sequelize.Op.in]: [boss.id, employee.id]}}});
      await models.LeaveType.destroy({where: {id: leaveType.id}});
      await models.Department.destroy({where: {id: department.id}});
      await models.Company.destroy({where: {id: company.id}});
    }
    await httpAgent.release();
  });

  afterEach(async function() {
    await models.Leave.destroy({where: {userId: employee.id}});
  });

  describe('a leave that may not be revoked', function() {

    const refuses = (label, status) => {
      it('refuses a ' + label + ' one', async function() {
        const leave = await book(status);

        expect(await revoking(leave), 'a ' + label + ' leave was revoked').to.be.an('error');

        await leave.reload();
        expect(leave.status, 'the status changed anyway').to.equal(status);
      });
    };

    refuses('rejected', 3);
    refuses('cancelled', 5);
    refuses('new', 1);

    // The view hides the button once a revoke is pending, and asking twice
    // would reset the approver.
    refuses('already pending revoke', 4);
  });

  describe('a leave that may', function() {

    it('moves an approved one to pending revoke', async function() {
      const leave = await book(2);

      expect(await revoking(leave)).to.equal(null);

      await leave.reload();
      expect(leave.status).to.equal(4);
    });

    it('sends it to the department boss for a decision', async function() {
      const leave = await book(2);

      await leave.promise_to_revoke();
      await leave.reload();

      expect(leave.approverId).to.equal(boss.id);
    });

    /*
      Someone whose requests skip approval has nobody to ask, so their revoke
      lands straight in rejected. Asserted because the guard sits in front of
      the branch that decides this.
    */
    it('rejects outright for an employee whose leave is auto-approved', async function() {
      await employee.update({auto_approve: true});

      try {
        const leave = await book(2);

        await leave.promise_to_revoke();
        await leave.reload();

        expect(leave.status).to.equal(3);
      } finally {
        await employee.update({auto_approve: false});
      }
    });
  });

  /*
    The reason the status check is worth having rather than tidy: this is the
    full path, and its last step turns a refusal into an approval.
  */
  describe('the path this closes', function() {

    it('does not let a rejected leave come back as approved', async function() {
      const leave = await book(3);

      expect(await revoking(leave)).to.be.an('error');

      await leave.reload();
      expect(leave.status, 'the leave reached the approver queue').to.equal(3);

      /*
        Had the revoke gone through, the leave would be pending revoke here, and
        promise_to_reject turns exactly that into Approved. Asserting the
        mechanism directly, so the consequence is on record even once the first
        step is closed.
      */
      const stillRejected = await book(3);
      expect(stillRejected.is_pended_revoke_leave()).to.equal(false);

      const pretendItGotThrough = await book(4);
      await pretendItGotThrough.promise_to_reject({by_user: boss});
      await pretendItGotThrough.reload();

      expect(pretendItGotThrough.status, 'rejecting a pending revoke approves the leave').to.equal(2);
    });
  });
});
