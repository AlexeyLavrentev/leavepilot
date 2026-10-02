'use strict';

/*
  Deactivation (past end_date) must evict more than the ability to log in.

  Two bearer paths bypass the login wall and historically never re-checked
  is_active(): passport's deserializeUser restored any session by bare user id,
  so a session minted before deactivation stayed fully authorized, and the
  unauthenticated iCal feed kept serving the deactivated user's own absences -
  and, for a teamview-type feed held by a deactivated admin, the whole
  company's.

  These assert both gates at the HTTP surface, and that active users are
  unaffected. The feed answers 404 on purpose: a distinct status would tell the
  holder their token is still live.
*/

const expect = require('chai').expect;
const httpAgent = require('../lib/http_agent');

describe('Deactivated user access gates', function() {

  this.timeout(30000);

  let models;
  let company;
  let department;
  let admin;
  let employee;
  let feedToken;
  let employeeAgent;

  before(async function() {
    await httpAgent.ready();
    models = httpAgent.getApp().get('db_model');

    company = await models.Company.create({
      name: 'Deactivation Gate Company', country: 'GB', start_of_new_year: 1,
    });
    department = await models.Department.create({
      name: 'Deactivation Gate Department', companyId: company.id,
    });
    admin = await models.User.create({
      name: 'Gate', lastname: 'Admin', email: 'deact-admin@test.com',
      password: models.User.hashify_password('test123'), companyId: company.id,
      DepartmentId: department.id, admin: true, activated: true,
    });
    employee = await models.User.create({
      name: 'Gate', lastname: 'Employee', email: 'deact-employee@test.com',
      password: models.User.hashify_password('test123'), companyId: company.id,
      DepartmentId: department.id, activated: true,
    });

    const feed = await models.UserFeed.promise_new_feed({user: employee, type: 'calendar'});
    feedToken = feed.raw_token;

    employeeAgent = await httpAgent.agent();
    await employeeAgent.post('/login/').send({email: 'deact-employee@test.com', password: 'test123'});
  });

  after(async function() {
    await httpAgent.release();
  });

  it('serves an active user on both surfaces', async function() {
    const calendar = await employeeAgent.get('/calendar/');
    expect(calendar.status, 'active employee keeps calendar access').to.equal(200);

    const res = await fetch((await httpAgent.agent()).baseUrl + '/feed/' + feedToken + '/ical.ics');
    expect(res.status, 'active employee feed is served').to.equal(200);
  });

  it('stops restoring a session for a user whose end_date has passed', async function() {
    await employee.update({end_date: '2020-01-01'});

    const res = await employeeAgent.get('/calendar/');
    expect(res.status, 'deactivated session is not authorized').to.be.oneOf([301, 302, 303]);
  });

  it('answers the deactivated user feed like an unknown token', async function() {
    const res = await fetch((await httpAgent.agent()).baseUrl + '/feed/' + feedToken + '/ical.ics');
    expect(res.status, 'deactivated feed is masked as unknown token').to.equal(404);
  });

  it('leaves active users unaffected', async function() {
    const adminAgent = await httpAgent.agent();
    await adminAgent.post('/login/').send({email: 'deact-admin@test.com', password: 'test123'});
    const res = await adminAgent.get('/calendar/');
    expect(res.status, 'active admin keeps access').to.equal(200);
  });

});
