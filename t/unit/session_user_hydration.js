'use strict';

/*
  Every authenticated request runs passport's deserializeUser, which calls
  reload_with_session_details, which calls promise_users_I_can_manage. For an
  admin that resolved to the company's with_all_users scope: the whole employee
  table, every column, hydrated per request.

  Two things read the result. lib/model/team_view.js keys a map by id, and
  views/partials/book_leave_modal.hbs renders the id and full_name. Nothing
  reads the rest — including the password hash, which was being loaded once per
  employee on every request an admin made.

  These assert the narrowing, and that it did not change which users come back.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');
const Sequelize = require('sequelize');

/*
  Its own database rather than the shared http_agent one: another unit file
  closes that connection in an after hook, and this file sorts after it, so
  borrowing it made the result depend on filename order.
*/
const buildModels = async () => {
  const sequelize = new Sequelize('database', null, null, {
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });

  const modelsDir = path.join(__dirname, '..', '..', 'lib', 'model', 'db');

  fs.readdirSync(modelsDir)
    .filter(name => name.endsWith('.js') && name !== 'index.js')
    .forEach(name => {
      const define = require(path.join(modelsDir, name));

      if (typeof define === 'function') {
        define(sequelize, Sequelize.DataTypes);
      }
    });

  Object.values(sequelize.models).forEach(model => {
    if (typeof model.associate === 'function') {
      model.associate(sequelize.models);
    }
  });

  // Core registers this during its own model bootstrap, not in associate(), so
  // the smaller graph built here has to declare it before the unrestricted
  // branch can run at all.
  sequelize.models.Company.addScope('with_all_users', {
    include : [{model : sequelize.models.User, as : 'users'}],
  });

  await sequelize.sync();

  return sequelize;
};

describe('Session user hydration', function() {

  this.timeout(20000);

  let sequelize;
  let models;
  let company;
  let admin;

  const EMPLOYEE_COUNT = 8;

  after(async function() {
    if (sequelize) {
      await sequelize.close();
    }
  });

  before(async function() {
    sequelize = await buildModels();
    models = sequelize.models;

    company = await models.Company.create({
      name: 'Hydration Company', country: 'GB', start_of_new_year: 1,
    });

    admin = await models.User.create({
      name: 'Hydration', lastname: 'Admin', email: 'hydration-admin@test.com',
      password: models.User.hashify_password('test123'),
      companyId: company.id, admin: true, activated: true,
    });

    for (let index = 0; index < EMPLOYEE_COUNT; index++) {
      await models.User.create({
        name: 'Employee' + index, lastname: 'Surname' + index,
        email: 'hydration-' + index + '@test.com',
        password: models.User.hashify_password('test123'),
        companyId: company.id, admin: false, activated: true,
      });
    }

    admin = await models.User.findOne({where: {id: admin.id}});
  });

  it('loads only the columns its readers use', async function() {
    const users = await admin.promise_users_I_can_manage({
      attributes: ['id', 'name', 'lastname'],
    });

    const colleague = users.find(user => user.id !== admin.id);

    expect(colleague, 'expected somebody other than the admin').to.be.an('object');
    expect(colleague.get('password'), 'the password hash is still being loaded')
      .to.equal(undefined);
    expect(colleague.get('email')).to.equal(undefined);

    // What the two readers actually need.
    expect(colleague.id).to.be.a('number');
    expect(colleague.full_name()).to.equal(colleague.name + ' ' + colleague.lastname);
  });

  /*
    The property that matters is ORDER, not membership.

    views/partials/book_leave_modal.hbs renders `value="{{@index}}"` — a
    position in this array — and lib/route/calendar.js resolves that index
    against a separate call to this same method, unrestricted. If narrowing
    changed the order, an admin could pick one colleague from the dropdown and
    book the leave for another, silently.

    The sort is on lastname alone, so colleagues sharing a surname are left in
    whatever order the query returned. The fixture below leans on exactly that:
    comparing sets, or comparing a fixture with unique surnames, would pass
    while the real hazard went unnoticed.
  */
  it('returns the same people in the same order, narrowed or not', async function() {
    const shared = [];

    for (let index = 0; index < 4; index++) {
      shared.push(await models.User.create({
        name: 'Twin' + index, lastname: 'Sharedsurname',
        email: 'twin-' + index + '@test.com',
        password: models.User.hashify_password('test123'),
        companyId: company.id, activated: true,
      }));
    }

    const wide = await admin.promise_users_I_can_manage();
    const narrow = await admin.promise_users_I_can_manage({
      attributes: ['id', 'name', 'lastname'],
    });

    expect(narrow.map(user => user.id)).to.deep.equal(
      wide.map(user => user.id),
      'narrowing reordered the list the booking modal indexes into'
    );
    expect(shared.every(twin => narrow.some(user => user.id === twin.id))).to.equal(true);
  });

  it('keeps deactivated colleagues and excludes other companies', async function() {
    const otherCompany = await models.Company.create({
      name: 'Somebody Else', country: 'GB', start_of_new_year: 1,
    });

    await models.User.create({
      name: 'Outside', lastname: 'Person', email: 'outsider@test.com',
      password: models.User.hashify_password('test123'),
      companyId: otherCompany.id, activated: true,
    });

    const deactivated = await models.User.create({
      name: 'Gone', lastname: 'Away', email: 'gone@test.com',
      password: models.User.hashify_password('test123'),
      companyId: company.id, activated: false,
    });

    const ids = (await admin.promise_users_I_can_manage({
      attributes: ['id', 'name', 'lastname'],
    })).map(user => user.id);

    // Counted from the database rather than from a constant: earlier cases in
    // this file seed users of their own, and a hard-coded total would make the
    // assertion depend on which of them ran first.
    const everyone = await models.User.findAll({where: {companyId: company.id}});

    expect(ids).to.include(deactivated.id, 'a deactivated colleague dropped out of the list');
    expect(ids.slice().sort()).to.deep.equal(
      everyone.map(user => user.id).sort(),
      'the list is not exactly this company'
    );
  });

  /*
    reload_with_session_details also loads the company with its leave types and
    the user's schedule. Those need Company scopes that core registers during
    its own model bootstrap, not in associate(), and this file deliberately
    builds a smaller model graph of its own. They are stubbed so the assertions
    stay on the part under test: what the session asks for, and what it keeps.
  */
  const hydrateSession = async () => {
    const user = await models.User.findOne({where: {id: admin.id}});
    const requested = [];
    const realManageable = user.promise_users_I_can_manage.bind(user);

    user.promise_users_I_can_manage = function(options) {
      requested.push(options);
      return realManageable(options);
    };
    user.get_company_with_all_leave_types = async () => company;
    user.promise_schedule_I_obey = async () => null;

    await user.reload_with_session_details();

    return {user, requested};
  };

  it('asks the session for only the columns its readers use', async function() {
    const {requested} = await hydrateSession();

    expect(requested).to.have.length(1);
    expect(requested[0]).to.deep.equal({attributes: ['id', 'name', 'lastname']});
  });

  it('hydrates the session without password hashes', async function() {
    const {user} = await hydrateSession();
    const colleague = (user.supervised_users || []).find(other => other.id !== admin.id);

    expect(colleague, 'the session carries no colleagues at all').to.be.an('object');
    expect(colleague.get('password'), 'the session still hydrates password hashes')
      .to.equal(undefined);
    expect(colleague.full_name()).to.equal(colleague.name + ' ' + colleague.lastname);
  });

  it('still sorts by surname, which the modal relies on', async function() {
    const {user} = await hydrateSession();
    const surnames = user.supervised_users.map(other => other.lastname);

    expect(surnames).to.deep.equal(
      surnames.slice().sort((left, right) => String(left).localeCompare(String(right)))
    );
  });
});
