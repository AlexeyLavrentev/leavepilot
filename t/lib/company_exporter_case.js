'use strict';

// A fresh process keeps the model registry bound to this test's database,
// independent of the HTTP harness's cached SQLite app in the parent suite.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const models = require('../../lib/model/db');
const CompanyExporter = require('../../lib/model/company/exporter');

async function main() {
  try {
    assert.equal(models.sequelize.getDialect(), process.env.DB_DIALECT);
    // Only the parent-created temporary database (or :memory:) is permitted.
    assert.ok(process.env.DB_DIALECT === 'sqlite' && process.env.DB_STORAGE === ':memory:'
      || process.env.DB_DIALECT === 'mysql' && /^lp_export_[a-f0-9]{24}$/.test(process.env.DB_NAME));
    await models.sequelize.sync();
    const companies = [];
    for (const [index, name] of ['Backup A', 'Backup B', 'Empty'].entries()) {
      const company = await models.Company.create({name, country: 'GB', start_of_new_year: 1, date_format: 'DD/MM/YYYY'});
      companies.push(company);
      if (index === 2) { continue; }
      const department = await models.Department.create({name: 'Engineering', companyId: company.id});
      const leaveType = await models.LeaveType.create({name: 'Holiday', companyId: company.id});
      const user = await models.User.create({
        name: index === 0 ? 'Jane' : 'Bob', lastname: 'Doe',
        email: index === 0 ? 'jane@example.test' : 'bob@example.test',
        password: 'synthetic-test-hash', companyId: company.id, DepartmentId: department.id,
      });
      await models.Leave.create({userId: user.id, leaveTypeId: leaveType.id,
        status: models.Leave.status_approved(), date_start: '2025-01-02', date_end: '2025-01-03'});
      // The actual scope must exclude these rows, not only sort the good ones.
      for (const status of [models.Leave.status_rejected(), models.Leave.status_canceled()]) {
        await models.Leave.create({userId: user.id, leaveTypeId: leaveType.id, status,
          date_start: '2025-02-02', date_end: '2025-02-03'});
      }
    }
    const exporter = new CompanyExporter({dbSchema: models});
    const summaries = await Promise.all(companies.map(company => exporter.promiseCompanySummary({company})));
    for (const summary of summaries.slice(0, 2)) {
      assert.equal(summary.users.length, 1);
      assert.equal(summary.users[0].my_leaves.length, 1);
      assert.ok(summary.users[0] instanceof models.User);
      assert.ok(summary.users[0].my_leaves[0] instanceof models.Leave);
    }
    const csv = await Promise.all(summaries.map(summary => summary.promise_as_csv_string()));
    assert.equal(csv[0], fs.readFileSync(path.join(__dirname, '../fixtures/company_backup/full.csv'), 'utf8'));
    assert.ok(csv[1].includes('Doe,Bob,bob@example.test'));
    assert.ok(!csv[0].includes('Bob') && !csv[1].includes('Jane'));
    assert.equal(csv[2], fs.readFileSync(path.join(__dirname, '../fixtures/company_backup/headers_only.csv'), 'utf8'));
    console.log(JSON.stringify({dialect: models.sequelize.getDialect(), companies: 3, hydratedUsers: 2, filteredLeaves: 4, exactCsv: true}));
  } finally {
    await models.sequelize.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
