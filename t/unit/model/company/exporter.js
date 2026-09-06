'use strict';

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');
const CompanyExporter = require('../../../../lib/model/company/exporter');
const CompanySummary = require('../../../../lib/model/company/exporter/summary');
const {spawnSync} = require('child_process');
const {randomBytes} = require('crypto');
const Sequelize = require('sequelize');
// Capture the runner's contour before other suites temporarily set SQLite env.
const dialect = process.env.DB_DIALECT === 'mysql' ? 'mysql' : 'sqlite';

const fixture = name => fs.readFileSync(
  path.join(__dirname, '../../../fixtures/company_backup', name),
  'utf8'
);

const leave = ({ id, leaveTypeId = 1, start, end }) => ({
  id,
  leaveTypeId,
  date_start: start,
  date_end: end,
  does_start_half_morning: () => false,
  does_start_half_afternoon: () => false,
  does_end_half_morning: () => false,
  does_end_half_afternoon: () => false,
});

const company = ({ departments, leaveTypes }) => ({
  id: 7,
  departments,
  leave_types: leaveTypes,
  get_default_date_format: () => 'DD/MM/YYYY',
});

const user = ({ id, departmentId = 1, lastname, name, email, leaves }) => ({
  id,
  DepartmentId: departmentId,
  lastname,
  name,
  email,
  my_leaves: leaves,
});

describe('company backup exporter', function() {
  const completeCompany = company({
    departments: [
      { id: 1, name: 'Engineering' },
      { id: 2, name: 'Operations' },
    ],
    leaveTypes: [{ id: 1, name: 'Holiday' }],
  });

  it(`round-trips tenant associations and CSV through real ${dialect}`, async function() {
    this.timeout(45000);
    const database = 'lp_export_' + randomBytes(12).toString('hex');
    let maintenance;
    let created = false;
    try {
      if (dialect === 'mysql') {
        maintenance = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
          dialect, host: process.env.DB_HOST || '127.0.0.1', port: process.env.DB_PORT || 3306,
          logging: false, dialectOptions: {connectTimeout: 5000},
        });
        await maintenance.query('CREATE DATABASE `' + database + '`');
        created = true;
      }
      const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../../lib/company_exporter_case.js')], {
        encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
        env: {...process.env, NODE_ENV: 'test', DB_DIALECT: dialect, DB_NAME: database,
          DB_STORAGE: ':memory:', DB_LOGGING: 'false', LEAVEPILOT_EDITION: 'community'},
      });
      expect(result.error, result.stderr).to.equal(undefined);
      expect(result.status, result.stderr).to.equal(0);
      const verdict = JSON.parse(result.stdout.trim().split('\n').at(-1));
      expect(verdict).to.deep.equal({dialect, companies: 3, hydratedUsers: 2, filteredLeaves: 4, exactCsv: true});
    } finally {
      if (maintenance) {
        try { if (created) { await maintenance.query('DROP DATABASE `' + database + '`'); } }
        finally { await maintenance.close(); }
      }
    }
  });

  it('returns a tenant-scoped summary through native Promise.all', async function() {
    const calls = [];
    const dbSchema = {
      Company: {
        scope: (...scopes) => ({
          findOne: options => {
            calls.push({ entity: 'company', scopes, options });
            return Promise.resolve(completeCompany);
          },
        }),
      },
      User: {
        scope: (...scopes) => ({
          findAll: options => {
            calls.push({ entity: 'user', scopes, options });
            return Promise.resolve([]);
          },
        }),
      },
    };

    const summary = await new CompanyExporter({ dbSchema })
      .promiseCompanySummary({ company: { id: 7 } });

    expect(summary).to.be.instanceOf(CompanySummary);
    expect(calls).to.deep.equal([
      {
        entity: 'company',
        scopes: ['with_simple_departments', 'with_leave_types'],
        options: { where: { id: 7 } },
      },
      {
        entity: 'user',
        scopes: ['with_simple_leaves'],
        options: { where: { companyId: 7 } },
      },
    ]);
  });

  it('keeps the established complete CSV bytes', async function() {
    const summary = new CompanySummary({
      company: completeCompany,
      users: [
        user({
          id: 1,
          lastname: 'Doe',
          name: 'Jane',
          email: 'jane@example.test',
          leaves: [leave({ id: 1, start: '2025-01-02', end: '2025-01-03' })],
        }),
      ],
    });

    expect(await summary.promise_as_csv_string()).to.equal(fixture('full.csv'));
  });

  it('uses every tie-breaker for users and leaves', function() {
    const summary = new CompanySummary({
      company: completeCompany,
      users: [
        user({
          id: 5,
          lastname: 'Doe',
          name: 'Jane',
          email: 'jane@example.test',
          leaves: [
            leave({ id: 4, start: '2025-01-03', end: '2025-01-03' }),
            leave({ id: 3, start: '2025-01-02', end: '2025-01-04' }),
            leave({ id: 2, start: '2025-01-02', end: '2025-01-03' }),
          ],
        }),
        user({
          id: 4,
          lastname: 'Doe',
          name: 'Jane',
          email: 'jane@example.test',
          leaves: [leave({ id: 1, start: '2025-01-02', end: '2025-01-02' })],
        }),
      ],
    });

    expect(summary.as_csv_data().slice(1).map(row => row.slice(5, 8))).to.deep.equal([
      ['02/01/2025', 'All Day', '02/01/2025'],
      ['02/01/2025', 'All Day', '03/01/2025'],
      ['02/01/2025', 'All Day', '04/01/2025'],
      ['03/01/2025', 'All Day', '03/01/2025'],
    ]);
  });

  it('returns headers only without leaves', async function() {
    const summary = new CompanySummary({ company: completeCompany, users: [] });

    expect(await summary.promise_as_csv_string()).to.equal(fixture('headers_only.csv'));
  });

  for (const count of [1, 2]) {
    for (const hasLeaves of [false, true]) {
      it(`rejects a missing department with ${count} users and ${hasLeaves ? 'some' : 'no'} leaves`, function() {
        const summary = new CompanySummary({
          company: completeCompany,
          users: Array.from({length: count}, (_, index) => user({
            id: index + 1, departmentId: 99, lastname: 'Doe', name: 'Jane', email: 'jane@example.test',
            leaves: hasLeaves ? [leave({id: 1, start: '2025-01-02', end: '2025-01-03'})] : [],
          })),
        });
        expect(() => summary.as_csv_data()).to.throw();
      });
    }
  }

  it('preserves headers-only output for valid users without leaves', async function() {
    const summary = new CompanySummary({company: completeCompany, users: [user({
      id: 1, lastname: 'Doe', name: 'Jane', email: 'jane@example.test', leaves: [],
    })]});
    expect(await summary.promise_as_csv_string()).to.equal(fixture('headers_only.csv'));
  });

  it('fails closed when a related association is missing', function() {
    const summary = new CompanySummary({
      company: completeCompany,
      users: [user({
        id: 1,
        lastname: 'Doe',
        name: 'Jane',
        email: 'jane@example.test',
        leaves: [leave({ id: 1, leaveTypeId: 99, start: '2025-01-02', end: '2025-01-02' })],
      })],
    });

    expect(() => summary.as_csv_data()).to.throw();
  });
});
