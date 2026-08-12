'use strict';

/*
  BRAND-04 / D-07 — the iCal feed is the one user-facing surface that used to
  emit ical-generator's default PRODID and an unbranded X-WR-CALNAME. The feed
  route now sources both from branding.get(), so a rebrand via BRAND_* changes
  the feed without a code edit.

  This is an integration spec (it boots the app + an in-memory SQLite DB via
  httpAgent), mirroring t/unit/feed_team_view_hidden.js: the only seam that
  proves the PRODID line actually carries the brand end-to-end is the route's
  own response body.
*/

const expect = require('chai').expect;
const httpAgent = require('../lib/http_agent');

describe('The iCal feed branding', function() {

  this.timeout(30000);

  let models;
  let company;
  let department;
  let admin;
  let employee;
  let employeeAgent;

  const feedOf = async (user, type) => {
    const feed = await models.UserFeed.promise_new_feed({user, type});

    return feed.feed_token;
  };

  const fetchFeed = token => employeeAgent.get('/feed/' + token + '/ical.ics');

  // BRAND_* is read live by branding.get() on every request (envResolver.getEnv
  // has no cache), so an override set in a nested before is honoured by the
  // fetch. Saved and restored so the override cannot leak into whichever suite
  // runs next in the same mocha process.
  const brandKeys = ['BRAND_NAME', 'BRAND_SHORT_NAME'];
  const savedBrandEnv = {};

  before(async function() {
    brandKeys.forEach(key => { savedBrandEnv[key] = process.env[key]; });

    await httpAgent.ready();
    models = httpAgent.getApp().get('db_model');

    company = await models.Company.create({
      name: 'Feed Branding Company', country: 'GB', start_of_new_year: 1,
    });
    department = await models.Department.create({
      name: 'Feed Branding Department', companyId: company.id,
    });
    admin = await models.User.create({
      name: 'Feed', lastname: 'Admin', email: 'feed-branding-admin@test.com',
      password: models.User.hashify_password('test123'), companyId: company.id,
      DepartmentId: department.id, admin: true, activated: true,
    });
    employee = await models.User.create({
      name: 'Feed', lastname: 'Employee', email: 'feed-branding-user@test.com',
      password: models.User.hashify_password('test123'), companyId: company.id,
      DepartmentId: department.id, activated: true,
    });
    await department.update({bossId: admin.id});

    // The feed route takes no session - the token is the credential - but the
    // agent gives us an http client against the running app.
    employeeAgent = await httpAgent.agent();
  });

  after(async function() {
    brandKeys.forEach(key => {
      if (typeof savedBrandEnv[key] === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = savedBrandEnv[key];
      }
    });

    if (models) {
      await models.UserFeed.destroy({where: {userId: {[models.Sequelize.Op.in]: [admin.id, employee.id]}}});
      await models.User.destroy({where: {id: {[models.Sequelize.Op.in]: [admin.id, employee.id]}}});
      await models.Department.destroy({where: {id: department.id}});
      await models.Company.destroy({where: {id: company.id}});
    }
    await httpAgent.release();
  });

  afterEach(async function() {
    await models.UserFeed.destroy({where: {userId: {[models.Sequelize.Op.in]: [admin.id, employee.id]}}});
  });

  describe('with a configured brand override', function() {

    before(function() {
      process.env.BRAND_NAME = 'Acme Leave';
      process.env.BRAND_SHORT_NAME = 'Acme';
    });

    it('carries the configured brand in the iCal PRODID', async function() {
      const token = await feedOf(employee, 'calendar');
      const response = await fetchFeed(token);

      expect(response.status).to.equal(200);
      expect(response.headers['content-type']).to.contain('text/calendar');
      // cal.prodId({company, product, language}) renders //-<company>-//-<product>-//<language>.
      expect(response.text).to.contain('PRODID:-//Acme Leave//Acme//EN');
    });

    it('prefixes the personal calendar X-WR-CALNAME with the brand', async function() {
      const token = await feedOf(employee, 'calendar');
      const response = await fetchFeed(token);

      expect(response.status).to.equal(200);
      const calnameLine = response.text.split('\n').find(line => line.indexOf('X-WR-CALNAME:') === 0);
      expect(calnameLine, 'X-WR-CALNAME line present').to.be.a('string');
      expect(calnameLine).to.contain('Acme Leave:');
      expect(calnameLine).to.contain('calendar');
    });

    it('prefixes the team-view feed X-WR-CALNAME with the brand', async function() {
      const token = await feedOf(employee, 'teamview');
      const response = await fetchFeed(token);

      expect(response.status).to.equal(200);
      const calnameLine = response.text.split('\n').find(line => line.indexOf('X-WR-CALNAME:') === 0);
      expect(calnameLine, 'X-WR-CALNAME line present').to.be.a('string');
      expect(calnameLine).to.contain('Acme Leave:');
    });
  });

  describe('with the default brand (no override)', function() {

    before(function() {
      delete process.env.BRAND_NAME;
      delete process.env.BRAND_SHORT_NAME;
    });

    it('produces the LeavePilot PRODID', async function() {
      const token = await feedOf(employee, 'calendar');
      const response = await fetchFeed(token);

      expect(response.status).to.equal(200);
      // DEFAULT_BRANDING.name / shortName are both 'LeavePilot' (D-01).
      expect(response.text).to.contain('PRODID:-//LeavePilot//LeavePilot//EN');
    });
  });
});
