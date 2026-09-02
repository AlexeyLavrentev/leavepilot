'use strict';

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');
const httpAgent = require('../../lib/http_agent');
const CompanyExporter = require('../../../lib/model/company/exporter');
const log = require('../../../lib/logger');

const fixture = fs.readFileSync(
  path.join(__dirname, '../../fixtures/company_backup/full.csv'),
  'utf8'
);

describe('company backup route', function() {
  this.timeout(30000);

  let models;
  let companyA;
  let companyB;
  let departmentA;
  let departmentB;
  let leaveTypeA;
  let leaveTypeB;
  let adminA;
  let adminB;
  let employeeA;
  let adminAAgent;
  let adminBAgent;
  let employeeAAgent;

  const login = async user => {
    const agent = await httpAgent.agent();
    await agent.post('/login/').type('form')
      .send({ email: user.email, password: 'test123' }).expect(302);
    return agent;
  };

  before(async function() {
    await httpAgent.ready();
    models = httpAgent.getApp().get('db_model');

    companyA = await models.Company.create({
      name: 'Backup Company A', country: 'GB', start_of_new_year: 1,
      date_format: 'DD/MM/YYYY',
    });
    companyB = await models.Company.create({
      name: 'Backup Company B', country: 'GB', start_of_new_year: 1,
      date_format: 'DD/MM/YYYY',
    });
    departmentA = await models.Department.create({ name: 'Engineering', companyId: companyA.id });
    departmentB = await models.Department.create({ name: 'Operations', companyId: companyB.id });
    leaveTypeA = await models.LeaveType.create({ name: 'Holiday', companyId: companyA.id });
    leaveTypeB = await models.LeaveType.create({ name: 'Other', companyId: companyB.id });
    adminA = await models.User.create({
      name: 'Jane', lastname: 'Doe', email: 'jane@example.test',
      password: models.User.hashify_password('test123'), companyId: companyA.id,
      DepartmentId: departmentA.id, admin: true, activated: true,
    });
    adminB = await models.User.create({
      name: 'Bob', lastname: 'Smith', email: 'company-backup-admin-b@test.com',
      password: models.User.hashify_password('test123'), companyId: companyB.id,
      DepartmentId: departmentB.id, admin: true, activated: true,
    });
    employeeA = await models.User.create({
      name: 'Alice', lastname: 'Employee', email: 'company-backup-user-a@test.com',
      password: models.User.hashify_password('test123'), companyId: companyA.id,
      DepartmentId: departmentA.id, admin: false, activated: true,
    });
    await models.Leave.create({
      userId: adminA.id, leaveTypeId: leaveTypeA.id,
      status: models.Leave.status_approved(),
      date_start: '2025-01-02', date_end: '2025-01-03',
    });
    await models.Leave.create({
      userId: adminB.id, leaveTypeId: leaveTypeB.id,
      status: models.Leave.status_approved(),
      date_start: '2025-02-02', date_end: '2025-02-03',
    });
    adminAAgent = await login(adminA);
    adminBAgent = await login(adminB);
    employeeAAgent = await login(employeeA);
  });

  after(async function() {
    if (models) {
      await models.Leave.destroy({where: {userId: {[models.Sequelize.Op.in]: [adminA.id, adminB.id]}}});
      await models.User.destroy({where: {id: {[models.Sequelize.Op.in]: [adminA.id, adminB.id, employeeA.id]}}});
      await models.LeaveType.destroy({where: {id: {[models.Sequelize.Op.in]: [leaveTypeA.id, leaveTypeB.id]}}});
      await models.Department.destroy({where: {id: {[models.Sequelize.Op.in]: [departmentA.id, departmentB.id]}}});
      await models.Company.destroy({where: {id: {[models.Sequelize.Op.in]: [companyA.id, companyB.id]}}});
    }
    await httpAgent.release();
  });

  it('sends tenant A exact buffered CSV with its attachment contract', async function() {
    const response = await adminAAgent.get('/settings/company/backup/');

    expect(response.status).to.equal(200);
    expect(response.headers['content-type']).to.contain('text/csv');
    expect(response.headers['content-disposition']).to.equal('attachment; filename="Backup_Company_A_backup.csv"');
    expect(response.text).to.equal(fixture);
    expect(response.text).to.not.contain('Bob,Smith');
  });

  it('denies an ordinary user before exporter work begins', async function() {
    const original = CompanyExporter.prototype.promiseCompanySummary;
    let called = false;
    CompanyExporter.prototype.promiseCompanySummary = function() {
      called = true;
      return original.apply(this, arguments);
    };
    try {
      const response = await employeeAAgent.get('/settings/company/backup/');
      expect(response.status).to.equal(303);
      expect(called).to.equal(false);
    } finally {
      CompanyExporter.prototype.promiseCompanySummary = original;
    }
  });

  it('keeps parallel company backups tenant-isolated', async function() {
    const [responseA, responseB] = await Promise.all([
      adminAAgent.get('/settings/company/backup/'),
      adminBAgent.get('/settings/company/backup/'),
    ]);

    expect(responseA.status).to.equal(200);
    expect(responseB.status).to.equal(200);
    expect(responseA.text).to.contain('Doe,Jane');
    expect(responseA.text).to.not.contain('Smith,Bob');
    expect(responseB.text).to.contain('Smith,Bob');
    expect(responseB.text).to.not.contain('Doe,Jane');
  });

  it('redirects generically and logs only safe backup failure details', async function() {
    const originalExport = CompanyExporter.prototype.promiseCompanySummary;
    const originalError = log.error;
    const entries = [];
    CompanyExporter.prototype.promiseCompanySummary = () => Promise.reject(
      new Error('backup-sentinel-secret')
    );
    log.error = (event, meta) => entries.push({ event, meta });
    try {
      const response = await adminAAgent.get('/settings/company/backup/');
      expect(response.status).to.equal(302);
      expect(response.headers.location).to.equal('/settings/general/');
      expect(response.text).to.not.contain('backup-sentinel-secret');
      expect(entries).to.deep.equal([{
        event: 'company_backup_failed',
        meta: { companyId: companyA.id, userId: adminA.id },
      }]);
    } finally {
      CompanyExporter.prototype.promiseCompanySummary = originalExport;
      log.error = originalError;
    }
  });
});
