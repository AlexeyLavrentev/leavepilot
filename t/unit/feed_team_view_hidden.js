'use strict';

/*
  A company can hide the team view. /calendar/teamview/ honours that:

    if (company.is_team_view_hidden && !can_view_all_absences) {
      return res.redirect_with_session('/');
    }

  The iCal feed serving the same data did not. /feed/<token>/ical.ics went
  straight to building a team-view calendar, so anyone holding the URL kept
  receiving "X is OOO" for every colleague across nine months - two past and
  six future - after the company had turned the page off.

  The token is theirs, not a public URL, which is what keeps this out of the
  urgent bracket. What makes it worth closing is that flipping the setting
  looked like it revoked something and did not: /calendar/feeds/ mints a
  team-view feed for anybody who opens the page, whether or not they may see
  team absences, the row survives the setting being turned on, and there is no
  way to withdraw it short of regenerating - which just issues another one.

  So two things: the feed route answers as though the token were unknown, and
  the page stops minting a token it will not show. The condition is the one
  the team-view page itself uses, since that is the authority on who may see
  these absences.

  Answering 404 "Unknown token provided" rather than 403 on purpose: a
  different answer for a real-but-refused token tells the holder their token is
  still live.
*/

const expect = require('chai').expect;
const httpAgent = require('../lib/http_agent');

describe('The team view feed when the company hides team view', function() {

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

  const hideTeamView = value => company.update({is_team_view_hidden: value});

  before(async function() {
    await httpAgent.ready();
    models = httpAgent.getApp().get('db_model');

    company = await models.Company.create({
      name: 'Feed Visibility Company', country: 'GB', start_of_new_year: 1,
      is_team_view_hidden: false,
    });
    department = await models.Department.create({
      name: 'Feed Visibility Department', companyId: company.id,
    });
    admin = await models.User.create({
      name: 'Feed', lastname: 'Admin', email: 'feed-visibility-admin@test.com',
      password: models.User.hashify_password('test123'), companyId: company.id,
      DepartmentId: department.id, admin: true, activated: true,
    });
    employee = await models.User.create({
      name: 'Feed', lastname: 'Employee', email: 'feed-visibility-user@test.com',
      password: models.User.hashify_password('test123'), companyId: company.id,
      DepartmentId: department.id, activated: true,
    });
    await department.update({bossId: admin.id});

    // The feed route takes no session - the token is the credential - but the
    // agent gives us an http client against the running app.
    employeeAgent = await httpAgent.agent();
  });

  after(async function() {
    if (models) {
      await models.UserFeed.destroy({where: {userId: {[models.Sequelize.Op.in]: [admin.id, employee.id]}}});
      await models.User.destroy({where: {id: {[models.Sequelize.Op.in]: [admin.id, employee.id]}}});
      await models.Department.destroy({where: {id: department.id}});
      await models.Company.destroy({where: {id: company.id}});
    }
    await httpAgent.release();
  });

  afterEach(async function() {
    await hideTeamView(false);
    await models.UserFeed.destroy({where: {userId: {[models.Sequelize.Op.in]: [admin.id, employee.id]}}});
  });

  describe('while team view is on show', function() {

    it('serves an employee their team view feed', async function() {
      const response = await fetchFeed(await feedOf(employee, 'teamview'));

      expect(response.status).to.equal(200);
      expect(response.headers['content-type']).to.contain('text/calendar');
    });
  });

  describe('once it is hidden', function() {

    it('stops serving an employee their team view feed', async function() {
      const token = await feedOf(employee, 'teamview');

      await hideTeamView(true);

      const response = await fetchFeed(token);

      expect(response.status, 'the feed kept answering after the setting was turned on')
        .to.equal(404);
    });

    // wallchart is the older name for the same feed and reads the same data.
    it('stops serving the wallchart feed too', async function() {
      const token = await feedOf(employee, 'wallchart');

      await hideTeamView(true);

      expect((await fetchFeed(token)).status).to.equal(404);
    });

    /*
      Their own calendar is their own absences, which the setting says nothing
      about. Breaking it would be a different bug.
    */
    it('still serves an employee their personal calendar feed', async function() {
      const token = await feedOf(employee, 'calendar');

      await hideTeamView(true);

      const response = await fetchFeed(token);

      expect(response.status).to.equal(200);
      expect(response.headers['content-type']).to.contain('text/calendar');
    });

    it('still serves the team view feed to someone who may see all absences', async function() {
      const token = await feedOf(admin, 'teamview');

      await hideTeamView(true);

      expect((await fetchFeed(token)).status).to.equal(200);
    });

    it('still serves it when the company shares all absences anyway', async function() {
      const token = await feedOf(employee, 'teamview');

      await hideTeamView(true);
      await company.update({share_all_absences: true});

      try {
        expect((await fetchFeed(token)).status).to.equal(200);
      } finally {
        await company.update({share_all_absences: false});
      }
    });

    // Same answer as a token that was never issued: a different one would tell
    // the holder that theirs is still live.
    it('answers exactly as it does for a token that does not exist', async function() {
      const token = await feedOf(employee, 'teamview');

      await hideTeamView(true);

      const refused = await fetchFeed(token);
      const nonsense = await fetchFeed('not-a-token-at-all');

      expect(refused.status).to.equal(nonsense.status);
      expect(refused.text).to.equal(nonsense.text);
    });
  });

  /*
    The other half. A token that is never issued cannot outlive the setting,
    and the page has hidden the card behind keep_team_view_hidden all along -
    so it was minting a row it would not show.
  */
  describe('the page that hands the tokens out', function() {

    let pageAgent;

    before(async function() {
      pageAgent = await httpAgent.agent();
      await pageAgent.post('/login/').type('form')
        .send({email: employee.email, password: 'test123'}).expect(302);
    });

    it('mints a team view feed while team view is on show', async function() {
      await pageAgent.get('/calendar/feeds/').expect(200);

      const feeds = await models.UserFeed.findAll({where: {userId: employee.id}});

      expect(feeds.map(feed => feed.type).sort()).to.deep.equal(['calendar', 'teamview']);
    });

    it('mints only the personal one once team view is hidden', async function() {
      await hideTeamView(true);

      await pageAgent.get('/calendar/feeds/').expect(200);

      const feeds = await models.UserFeed.findAll({where: {userId: employee.id}});

      expect(feeds.map(feed => feed.type)).to.deep.equal(
        ['calendar'],
        'a team view token was issued for a page that will not show it'
      );
    });

    it('still shows the page rather than falling over', async function() {
      await hideTeamView(true);

      const response = await pageAgent.get('/calendar/feeds/').expect(200);

      expect(response.text).to.contain('feed-card');
    });
  });
});
