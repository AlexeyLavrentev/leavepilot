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
const branding = require('../../lib/branding');

// D-04: under the OEM gate an operator BRAND_* override only surfaces with a
// custom_branding entitlement. The override describes below inject an unsigned
// OEM license (valid in NODE_ENV=test via allowUnsignedLicenses) and reset the
// memoized entitlement cache so the HTTP request re-evaluates it.
const OEM_LICENSE_PAYLOAD = JSON.stringify({
  customer: 'Test OEM',
  features: ['custom_branding'],
});

// The vendor-literal regex shared with t/unit/oem_no_vendor_leak.js (OEM-04).
// Each override response below already asserts the custom brand IS present; the
// vendor-absent tooth added in plan 04-03 makes the canonical iCal render test
// independently prove the surface leaks nothing under a custom brand — so the
// leak regression guard is not the only thing standing between a reintroduced
// vendor literal and a shipped white-label feed.
const brandLiteral = /LeavePilot|Leave\s+Pilot|TimeOff|timeoff\.management/i;

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
  // runs next in the same mocha process. LEAVEPILOT_LICENSE is snapshotted
  // alongside (D-04: the override describes inject an OEM entitlement).
  const brandKeys = ['BRAND_NAME', 'BRAND_SHORT_NAME', 'LEAVEPILOT_LICENSE'];
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
      process.env.LEAVEPILOT_LICENSE = OEM_LICENSE_PAYLOAD;
      process.env.BRAND_NAME = 'Acme Leave';
      process.env.BRAND_SHORT_NAME = 'Acme';
      branding.__resetOemCacheForTests();
    });

    it('carries the configured brand in the iCal PRODID', async function() {
      const token = await feedOf(employee, 'calendar');
      const response = await fetchFeed(token);

      expect(response.status).to.equal(200);
      expect(response.headers['content-type']).to.contain('text/calendar');
      // cal.prodId({company, product, language}) renders //-<company>-//-<product>-//<language>.
      expect(response.text).to.contain('PRODID:-//Acme Leave//Acme//EN');
      // OEM-04 vendor-absent tooth: under a custom brand no vendor literal
      // (LeavePilot / Leave Pilot / TimeOff / timeoff.management) survives in
      // the rendered iCal body.
      expect(response.text, 'the iCal body must carry no vendor literal under a custom brand').to.not.match(brandLiteral);
    });

    it('prefixes the personal calendar X-WR-CALNAME with the brand', async function() {
      const token = await feedOf(employee, 'calendar');
      const response = await fetchFeed(token);

      expect(response.status).to.equal(200);
      const calnameLine = response.text.split('\n').find(line => line.indexOf('X-WR-CALNAME:') === 0);
      expect(calnameLine, 'X-WR-CALNAME line present').to.be.a('string');
      expect(calnameLine).to.contain('Acme Leave:');
      expect(calnameLine).to.contain('calendar');
      // OEM-04 vendor-absent tooth on the whole iCal body.
      expect(response.text, 'the iCal body must carry no vendor literal under a custom brand').to.not.match(brandLiteral);
    });

    it('prefixes the team-view feed X-WR-CALNAME with the brand', async function() {
      const token = await feedOf(employee, 'teamview');
      const response = await fetchFeed(token);

      expect(response.status).to.equal(200);
      const calnameLine = response.text.split('\n').find(line => line.indexOf('X-WR-CALNAME:') === 0);
      expect(calnameLine, 'X-WR-CALNAME line present').to.be.a('string');
      expect(calnameLine).to.contain('Acme Leave:');
      // OEM-04 vendor-absent tooth on the whole iCal body.
      expect(response.text, 'the iCal body must carry no vendor literal under a custom brand').to.not.match(brandLiteral);
    });
  });

  describe('with the default brand (no override)', function() {

    before(function() {
      delete process.env.LEAVEPILOT_LICENSE;
      delete process.env.BRAND_NAME;
      delete process.env.BRAND_SHORT_NAME;
      branding.__resetOemCacheForTests();
    });

    it('produces the LeavePilot PRODID', async function() {
      const token = await feedOf(employee, 'calendar');
      const response = await fetchFeed(token);

      expect(response.status).to.equal(200);
      // DEFAULT_BRANDING.name / shortName are both 'LeavePilot' (D-01).
      expect(response.text).to.contain('PRODID:-//LeavePilot//LeavePilot//EN');
    });
  });

  describe('with a multi-line brand name (CRLF hardening)', function() {

    // ical-generator 11.1.0 does not escape CR/LF inside PRODID or
    // X-WR-CALNAME values (WR-03). An operator-controlled multi-line
    // BRAND_NAME would otherwise inject extra iCal property lines into
    // every subscriber's calendar (an operator self-DoS shape). feed.js
    // flattens brand.name/brand.shortName to a single line before they
    // reach ical-generator; this block proves the flattening holds
    // end-to-end on the wire bytes.
    let savedName;
    let savedShortName;

    before(function() {
      savedName = process.env.BRAND_NAME;
      savedShortName = process.env.BRAND_SHORT_NAME;
      // The '\n' is a real newline character: without single-line coercion
      // it splits the PRODID/X-WR-CALNAME value across iCal property lines.
      process.env.LEAVEPILOT_LICENSE = OEM_LICENSE_PAYLOAD;
      process.env.BRAND_NAME = 'Acme\nINJECTED:evil';
      process.env.BRAND_SHORT_NAME = 'Acme\nX-INJECTED:bad';
      branding.__resetOemCacheForTests();
    });

    after(function() {
      if (typeof savedName === 'undefined') {
        delete process.env.BRAND_NAME;
      } else {
        process.env.BRAND_NAME = savedName;
      }
      if (typeof savedShortName === 'undefined') {
        delete process.env.BRAND_SHORT_NAME;
      } else {
        process.env.BRAND_SHORT_NAME = savedShortName;
      }
    });

    it('flattens a multi-line BRAND_NAME in the iCal PRODID', async function() {
      const token = await feedOf(employee, 'calendar');
      const response = await fetchFeed(token);

      expect(response.status).to.equal(200);
      const lines = response.text.split('\n');
      const prodidLine = lines.find(line => line.indexOf('PRODID:') === 0);
      expect(prodidLine, 'PRODID line present').to.be.a('string');
      // Both the legitimate token and the injected token ride the SAME
      // PRODID line: the newline was flattened to a space, not emitted as
      // a line break that would split the property into its own line.
      expect(prodidLine).to.contain('Acme');
      expect(prodidLine).to.contain('INJECTED:evil');
      // No line in the body is the bare injected token: that would only
      // exist if the newline had split a record into its own property line.
      expect(
        lines,
        'the injected token must not appear as its own iCal line'
      ).to.not.include('INJECTED:evil');
    });

    it('flattens a multi-line BRAND_NAME in the X-WR-CALNAME', async function() {
      const token = await feedOf(employee, 'calendar');
      const response = await fetchFeed(token);

      expect(response.status).to.equal(200);
      const lines = response.text.split('\n');
      const calnameLine = lines.find(line => line.indexOf('X-WR-CALNAME:') === 0);
      expect(calnameLine, 'X-WR-CALNAME line present').to.be.a('string');
      // Same single-line guarantee mirrored on the X-WR-CALNAME line.
      expect(calnameLine).to.contain('Acme');
      expect(calnameLine).to.contain('INJECTED:evil');
    });
  });
});
