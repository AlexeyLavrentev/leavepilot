'use strict';

const expect = require('chai').expect;
const httpAgent = require('../lib/http_agent');
const Email = require('../../lib/email');

describe('Reminder schedules UI and API', function() {
  this.timeout(20000);

  let agent;
  let regularAgent;
  let models;
  let company;
  let otherCompany;
  let department;
  let leaveType;
  let otherLeaveType;
  let admin;
  let regular;
  let leave;
  let scheduleId;

  before(async function() {
    await httpAgent.ready();
    models = httpAgent.getApp().get('db_model');
    company = await models.Company.create({name: 'Reminder Company', country: 'GB', start_of_new_year: 1});
    otherCompany = await models.Company.create({name: 'Other Reminder Company', country: 'GB', start_of_new_year: 1});
    department = await models.Department.create({name: 'Reminder Department', companyId: company.id});
    leaveType = await models.LeaveType.create({name: 'Annual reminder leave', companyId: company.id});
    otherLeaveType = await models.LeaveType.create({name: 'Foreign leave', companyId: otherCompany.id});
    admin = await models.User.create({
      name: 'Reminder', lastname: 'Admin', email: 'reminder-admin@test.com',
      password: models.User.hashify_password('test123'), companyId: company.id,
      DepartmentId: department.id, admin: true, activated: true,
    });
    regular = await models.User.create({
      name: 'Reminder', lastname: 'Employee', email: 'reminder-user@test.com',
      password: models.User.hashify_password('test123'), companyId: company.id,
      DepartmentId: department.id, admin: false, activated: true,
    });
    await department.update({bossId: admin.id});
    leave = await models.Leave.create({
      userId: regular.id,
      leaveTypeId: leaveType.id,
      date_start: '2026-09-10',
      date_end: '2026-09-12',
      status: models.Leave.status_approved(),
    });

    agent = await httpAgent.agent();
    await agent.post('/login/').type('form').send({email: admin.email, password: 'test123'}).expect(302);
    regularAgent = await httpAgent.agent();
    await regularAgent.post('/login/').type('form').send({email: regular.email, password: 'test123'}).expect(302);
  });

  after(async function() {
    if (models) {
      await models.ReminderSchedule.destroy({where: {company_id: company.id}});
      await models.Leave.destroy({where: {id: leave.id}});
      await models.User.destroy({where: {id: {[models.Sequelize.Op.in]: [admin.id, regular.id]}}});
      await models.Department.destroy({where: {id: department.id}});
      await models.LeaveType.destroy({where: {id: {[models.Sequelize.Op.in]: [leaveType.id, otherLeaveType.id]}}});
      await models.Company.destroy({where: {id: {[models.Sequelize.Op.in]: [company.id, otherCompany.id]}}});
    }
    // This suite shares the in-process SQLite fixture with later route suites.
    // `close()` tears down its memoised Sequelize connection permanently;
    // release only this suite's listener and environment overrides.
    await httpAgent.release();
  });

  it('renders a functional localized settings page for admins', async function() {
    const response = await agent.get('/settings/reminder-schedules/').expect(200);
    expect(response.text).to.contain('id="schedule-form"');
    expect(response.text).to.not.contain('TODO:');
    expect(response.text).to.not.contain('reminderSchedules.title');
  });

  it('blocks regular employees from settings and API', async function() {
    await regularAgent.get('/settings/reminder-schedules/').expect(303);
    await regularAgent.get('/api/reminder-schedules').expect(303);
  });

  it('creates, lists, updates and deletes a company-scoped schedule', async function() {
    const created = await agent.post('/api/reminder-schedules').send({
      leaveTypeId: leaveType.id,
      daysBefore: 14,
      recipientSupervisor: true,
      recipientEmployee: false,
    }).expect(201).expect('Content-Type', /json/);
    scheduleId = created.body.schedule.id;

    const listed = await agent.get('/api/reminder-schedules').expect(200);
    expect(listed.body.schedules.map(item => item.id)).to.contain(scheduleId);

    const updated = await agent.put(`/api/reminder-schedules/${scheduleId}`).send({
      recipientSupervisor: false,
      recipientEmployee: true,
      isActive: false,
    }).expect(200);
    expect(updated.body.schedule.recipientSupervisor).to.be.false;
    expect(updated.body.schedule.recipientEmployee).to.be.true;
    expect(updated.body.schedule.isActive).to.be.false;

    await agent.delete(`/api/reminder-schedules/${scheduleId}`).expect(204);
    expect(await models.ReminderSchedule.findByPk(scheduleId)).to.be.null;
  });

  it('rejects duplicates, empty recipients and foreign leave types', async function() {
    const payload = {
      leaveTypeId: leaveType.id,
      daysBefore: 7,
      recipientSupervisor: true,
      recipientEmployee: false,
    };
    const created = await agent.post('/api/reminder-schedules').send(payload).expect(201);
    scheduleId = created.body.schedule.id;
    await agent.post('/api/reminder-schedules').send(payload).expect(400);
    const second = await agent.post('/api/reminder-schedules').send({...payload, daysBefore: 8}).expect(201);
    await agent.put(`/api/reminder-schedules/${second.body.schedule.id}`).send({daysBefore: 7}).expect(400);
    await agent.post('/api/reminder-schedules').send({
      leaveTypeId: leaveType.id, daysBefore: 3,
      recipientSupervisor: false, recipientEmployee: false,
    }).expect(400);
    await agent.post('/api/reminder-schedules').send({
      leaveTypeId: otherLeaveType.id, daysBefore: 3,
      recipientSupervisor: true, recipientEmployee: false,
    }).expect(400);
  });

  it('returns reminder history and performs a safe test send', async function() {
    const history = await agent.get('/api/reminder-schedules/history').expect(200);
    expect(history.body.notifications).to.be.an('array');

    const original = Email.prototype.promise_upcoming_leave_start_reminder_email;
    let sent;
    try {
      Email.prototype.promise_upcoming_leave_start_reminder_email = async args => { sent = args; };
      const response = await agent.post('/api/reminder-schedules/test-send').send({
        leaveId: leave.id,
        daysBefore: 5,
      }).expect(200);
      expect(response.body.success).to.be.true;
      expect(sent.recipient.id).to.equal(admin.id);
      expect(sent.employee.id).to.equal(regular.id);
      expect(sent.daysBefore).to.equal(5);
    } finally {
      Email.prototype.promise_upcoming_leave_start_reminder_email = original;
    }
  });
});
