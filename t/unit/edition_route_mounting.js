'use strict';

/*
  An edition registers a router with middleware in front of it, and the registry
  mounts the two together:

    app.use(path, ...middleware, router)

  Express makes each of those middleware its own layer matching `path` as a
  prefix. At path '/' the prefix is every URL, so the middleware stops being a
  gate on the router beside it and becomes a gate on the whole application from
  that mount point onwards.

  Two editions registered an admin gate that way. Nothing looked wrong to an
  admin, and for everyone else it was total:

    EMPLOYEE 303 /time-balance/              -> /
    EMPLOYEE 303 /vacation-plans/            -> /
    EMPLOYEE 303 /reports/no-leave/          -> /
    EMPLOYEE 303 /this-route-does-not-exist/ -> /
    ADMIN    200 /time-balance/
    ADMIN    404 /this-route-does-not-exist/

  The community gates are registered before any premium route, so in the
  premium edition they swallowed every premium page. In this edition alone the
  routes mounted after them - /audit/ and /reports/ - carry their own admin
  check, so what was left was the not-found handler: a mistyped address
  redirected to the dashboard for anyone who was not an admin, which is the
  status the 404 work in 0cfaf92 had just set out to fix.

  Two contracts, and the second is the one that matters: the gate has to keep
  refusing non-admins on the routes it owns, while everything else reaches its
  own route.
*/

const expect = require('chai').expect;
const express = require('express');
const httpAgent = require('../lib/http_agent');
const EditionRegistry = require('../../lib/edition/registry');

describe('Edition route mounting', function() {

  this.timeout(30000);

  describe('the registry', function() {

    const registry = () => new EditionRegistry();
    const gate = (req, res, next) => next();

    it('refuses middleware mounted at the root', function() {
      expect(() => registry().registerRoute({
        name: 'careless', path: '/', middleware: [gate], router: express.Router(),
      })).to.throw(/applies it to every request/);
    });

    it('names the route so the message says which registration to fix', function() {
      expect(() => registry().registerRoute({
        name: 'reminder-schedules-api', path: '/', middleware: [gate], router: express.Router(),
      })).to.throw(/reminder-schedules-api/);
    });

    // A single function rather than an array is accepted everywhere else, so
    // the check cannot be one that only looks at arrays.
    it('refuses a single middleware just the same', function() {
      expect(() => registry().registerRoute({
        name: 'careless', path: '/', middleware: gate, router: express.Router(),
      })).to.throw(/applies it to every request/);
    });

    /*
      A router at '/' on its own is not the problem: one that matches nothing
      calls next() and the request carries on. Only a sibling middleware turns
      the mount into a gate over everything.
    */
    it('allows a router at the root when nothing is mounted in front of it', function() {
      expect(() => registry().registerRoute({
        name: 'plain', path: '/', router: express.Router(),
      })).to.not.throw();
    });

    it('allows the same middleware under the prefix its router serves', function() {
      expect(() => registry().registerRoute({
        name: 'careful', path: '/api/reminder-schedules', middleware: [gate], router: express.Router(),
      })).to.not.throw();
    });
  });

  describe('the application it produces', function() {

    let models;
    let company;
    let department;
    let admin;
    let employee;
    let adminAgent;
    let employeeAgent;

    // One fixture for both halves: httpAgent.close() takes the database down
    // with it, so it can only be called once.
    before(async function() {
      await httpAgent.ready();
      models = httpAgent.getApp().get('db_model');

      company = await models.Company.create({
        name: 'Route Mounting Company', country: 'GB', start_of_new_year: 1,
      });
      department = await models.Department.create({
        name: 'Route Mounting Department', companyId: company.id,
      });
      admin = await models.User.create({
        name: 'Mounting', lastname: 'Admin', email: 'route-mounting-admin@test.com',
        password: models.User.hashify_password('test123'), companyId: company.id,
        DepartmentId: department.id, admin: true, activated: true,
      });
      employee = await models.User.create({
        name: 'Mounting', lastname: 'Employee', email: 'route-mounting-user@test.com',
        password: models.User.hashify_password('test123'), companyId: company.id,
        DepartmentId: department.id, admin: false, activated: true,
      });
      await department.update({bossId: admin.id});

      adminAgent = await httpAgent.agent();
      await adminAgent.post('/login/').type('form')
        .send({email: admin.email, password: 'test123'}).expect(302);
      employeeAgent = await httpAgent.agent();
      await employeeAgent.post('/login/').type('form')
        .send({email: employee.email, password: 'test123'}).expect(302);
    });

    /*
      release() rather than close(): the database is shared with the suites that
      run after this one, and leaving it open is what keeps their connection
      alive. It still puts the environment back, which close() was the only
      thing doing.
    */
    after(async function() {
      if (models) {
        await models.User.destroy({where: {id: {[models.Sequelize.Op.in]: [admin.id, employee.id]}}});
        await models.Department.destroy({where: {id: department.id}});
        await models.Company.destroy({where: {id: company.id}});
      }
      await httpAgent.release();
    });

    describe('what a non-admin gets', function() {

      /*
        The one this edition loses on its own. 303 here means the request never
        reached the last handler in the chain.
      */
      it('reaches the not-found page for an address that is not there', async function() {
        const response = await employeeAgent.get('/this-route-does-not-exist/');

        expect(response.status).to.equal(
          404,
          'a non-admin was redirected instead of reaching the not-found handler'
        );
      });

      it('reaches the JSON not-found answer under /api/ too', async function() {
        const response = await employeeAgent.get('/api/v1/definitely-not-here');

        expect(response.status).to.equal(404);
        expect(response.headers['content-type']).to.contain('application/json');
      });

      // An admin always got these; asserting both sides is what shows the gate
      // moved rather than went away.
      it('gives an admin the same not-found answers', async function() {
        expect((await adminAgent.get('/this-route-does-not-exist/')).status).to.equal(404);
        expect((await adminAgent.get('/api/v1/definitely-not-here')).status).to.equal(404);
      });

      it('lets a non-admin reach a page mounted after the edition routes', async function() {
        const response = await employeeAgent.get('/calendar/');

        expect(response.status).to.equal(200);
      });
    });

    /*
      The gate is still a gate. Moving it off '/' would be worth nothing if it
      stopped refusing anyone on the routes it was written for.
    */
    describe('the routes the gate owns', function() {

      it('still refuses a non-admin the settings page', async function() {
        const response = await employeeAgent.get('/settings/reminder-schedules/');

        expect(response.status).to.equal(303);
        expect(response.headers.location).to.equal('/');
      });

      it('still refuses a non-admin the API', async function() {
        const response = await employeeAgent.get('/api/reminder-schedules');

        expect(response.status).to.equal(303);
      });

      /*
        The paths moved from absolute to relative when the routers gained a
        mount prefix, so every URL the client script and the navigation item
        name has to be asked for rather than assumed.
      */
      it('serves the settings page to an admin at the same URL as before', async function() {
        const response = await adminAgent.get('/settings/reminder-schedules/').expect(200);

        expect(response.text).to.contain('reminder-schedules-page');
      });

      it('serves the API to an admin at the same URLs as before', async function() {
        const list = await adminAgent.get('/api/reminder-schedules').expect(200);

        expect(list.body).to.have.property('schedules');

        const history = await adminAgent.get('/api/reminder-schedules/history');

        expect(history.status).to.equal(200);
      });

      /*
        '/history' is a literal and '/:id' is a parameter, and PUT '/:id' would
        happily match '/history' if the two were declared the other way round.
      */
      it('does not let the id parameter swallow the named sub-paths', async function() {
        const response = await adminAgent.get('/api/reminder-schedules/history');

        expect(response.status).to.equal(200);
        expect(response.body).to.not.have.property('schedule');
      });
    });
  });
});
