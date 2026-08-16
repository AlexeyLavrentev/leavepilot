'use strict';

/*
  Plan 05-06 (QUAL-03, D-08/D-09/D-11): one honest pre-state replay case for
  a data-rewriting migration, executed in a dedicated child process.

  Why a child process: one migration in the manifest (20191030 compress
  email audit) performs its rewrite through the lib/model/db models
  SINGLETON rather than the queryInterface the migrator hands it, and every
  later case's 1..N-1 replay executes that migration too. The singleton
  binds its connection at require time from DB_DIALECT/DB_STORAGE/DB_NAME,
  so per-case database isolation (Pitfall 7, T-05-17) is only achievable by
  binding a fresh process per case: the parent spawns this script with the
  per-case env, the singleton lands on the case database, and no case can
  see another's schema or rows.

  What this script does per case (argv[2] = migration file name):
    1. builds the minimal original-shape base - the pre-migration-1 sync
       stand-in (Companies/Departments/Users/LeaveTypes/BankHolidays/
       EmailAudit/audit as of 2017, FK-free, exactly the tables the history
       itself can never create; everything after migration 1 is produced by
       the history);
    2. replays migrations 1..N-1 through lib/model/migrator.js exports -
       createUmzug(sequelize, Sequelize, <real history dir>) with umzug's
       native { to } bound on the migrator-built instance (the migrator's
       own adapter, storage and v2 signature resolve; runPending is the
       no-bound special case of the same call). The spec never constructs
       its own umzug/storage/adapter;
    3. seeds the synthetic pre-state rows the scenario defines (D-11) -
       written from the migration's own up() expectations;
    4. executes N the same way;
    5. asserts the dual D-09 proof: the migrator's SequelizeMeta table
       carries exactly the replayed names INCLUDING N (a sync-bootstrapped
       empty database carries none - asserted in the same run on a second
       fresh database via bootstrapEmptyDatabase), plus the scenario's
       concrete transformed-data asserts (values, not counts).

  Output: the LAST stdout line is a JSON verdict the parent asserts on;
  any assertion failure exits non-zero with the error on stderr. The
  scenario's own asserts use node:assert, so a red scenario is a red case.
*/

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Sequelize = require('sequelize');
const migrator = require('../../lib/model/migrator');

const ROOT = path.join(__dirname, '..', '..');
const CORE_HISTORY = path.join(ROOT, 'migrations');
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 't', 'fixtures', 'data-rewriting-migrations.json'), 'utf8')
);

const dialect = process.env.DB_DIALECT === 'mysql' ? 'mysql' : 'sqlite';
const storageDir = process.env.CASE_STORAGE_DIR || os_tmpdir();
const caseSlugBase = process.env.CASE_SLUG;
const negDbName = process.env.CASE_NEG_DB;

function os_tmpdir() {
  return require('os').tmpdir();
}

function connectionOptions(database) {
  if (dialect === 'mysql') {
    return {
      database: database,
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || '3306',
      dialect: 'mysql',
      logging: false,
    };
  }
  return { dialect: 'sqlite', storage: database, logging: false };
}

// ---------------------------------------------------------------------------
// The original-shape base (pre-migration-1 sync stand-in). Column shapes
// are the ones the migrations' own copy lists and guards reference; every
// column the history adds is left out on purpose so migrations 1..N-1 do
// real work when the replay executes them.
// ---------------------------------------------------------------------------

const NOW = new Date();

async function createOriginalBase(qi) {
  const DATE = { type: Sequelize.DATE, allowNull: false };

  await qi.createTable('Companies', {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: Sequelize.STRING, allowNull: false },
    country: { type: Sequelize.STRING, allowNull: false },
    start_of_new_year: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
    createdAt: DATE,
    updatedAt: DATE,
    share_all_absences: Sequelize.BOOLEAN,
    ldap_auth_enabled: Sequelize.BOOLEAN,
    ldap_auth_config: Sequelize.TEXT,
  });
  await qi.createTable('Departments', {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: Sequelize.STRING, allowNull: false },
    include_public_holidays: Sequelize.BOOLEAN,
    createdAt: DATE,
    updatedAt: DATE,
    companyId: Sequelize.INTEGER,
    bossId: Sequelize.INTEGER,
    allowence: Sequelize.INTEGER,
  });
  await qi.createTable('Users', {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    email: { type: Sequelize.STRING, allowNull: false },
    password: { type: Sequelize.STRING, allowNull: false },
    name: Sequelize.STRING,
    lastname: Sequelize.STRING,
    activated: Sequelize.BOOLEAN,
    admin: Sequelize.BOOLEAN,
    start_date: Sequelize.DATEONLY,
    end_date: Sequelize.DATEONLY,
    createdAt: DATE,
    updatedAt: DATE,
    companyId: Sequelize.INTEGER,
    DepartmentId: Sequelize.INTEGER,
    adjustment: Sequelize.INTEGER,
  });
  await qi.createTable('LeaveTypes', {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: Sequelize.STRING, allowNull: false },
    companyId: Sequelize.INTEGER,
    color: Sequelize.STRING,
    createdAt: DATE,
    updatedAt: DATE,
  });
  await qi.createTable('BankHolidays', {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: Sequelize.STRING, allowNull: false },
    date: { type: Sequelize.DATEONLY, allowNull: false },
    companyId: { type: Sequelize.INTEGER, allowNull: false },
    createdAt: DATE,
    updatedAt: DATE,
  });
  await qi.createTable('EmailAudit', {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    // Column set matches today's EmailAudit model (underscored, tableName
    // frozen): the 20191030 compression migration reads this table through
    // the models singleton, whose findAll() selects every attribute.
    user_id: Sequelize.INTEGER,
    company_id: Sequelize.INTEGER,
    email: { type: Sequelize.STRING, allowNull: false },
    subject: { type: Sequelize.TEXT, allowNull: false },
    body: { type: Sequelize.TEXT, allowNull: false },
    status: Sequelize.STRING,
    created_at: DATE,
  });
  await qi.createTable('audit', {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    entityType: { type: Sequelize.STRING, allowNull: false },
    entityId: { type: Sequelize.INTEGER, allowNull: false },
    attribute: { type: Sequelize.STRING, allowNull: false },
    oldValue: Sequelize.STRING,
    newValue: Sequelize.STRING,
    at: DATE,
  });
}

// ---------------------------------------------------------------------------
// Assertion bookkeeping: every assert goes through ok(), so the verdict
// line carries how many ran and the parent can refuse a vacuous child.
// ---------------------------------------------------------------------------

const state = { assertions: 0 };

function ok(value, message) {
  state.assertions += 1;
  assert.ok(value, message);
}

function equal(actual, expected, message) {
  state.assertions += 1;
  assert.strictEqual(actual, expected, message + ' (expected ' + JSON.stringify(expected)
    + ', got ' + JSON.stringify(actual) + ')');
}

function deepEqual(actual, expected, message) {
  state.assertions += 1;
  assert.deepStrictEqual(actual, expected, message);
}

async function select(sequelize, sql, replacements) {
  return sequelize.query(sql, {
    replacements: replacements || {},
    type: Sequelize.QueryTypes.SELECT,
  });
}

// ---------------------------------------------------------------------------
// Scenarios: synthetic pre-state seeding (after 1..N-1, before N) and the
// concrete transformed-data asserts (after N). Written from each up()'s own
// expectations (D-11).
// ---------------------------------------------------------------------------

function companyRow(overrides) {
  return Object.assign({
    id: 1,
    name: 'ACME Ltd',
    country: 'GB',
    start_of_new_year: 1,
    createdAt: NOW,
    updatedAt: NOW,
    share_all_absences: false,
    ldap_auth_enabled: false,
  }, overrides || {});
}

const SCENARIOS = {
  '20170329060832-rename_allowence_to_allowance.js': {
    seed: async function(qi) {
      await qi.bulkInsert('Companies', [companyRow()]);
      await qi.bulkInsert('Departments', [{
        id: 1,
        name: 'Sales',
        companyId: 1,
        include_public_holidays: true,
        allowence: 5,
        createdAt: NOW,
        updatedAt: NOW,
      }]);
    },
    assert: async function(sequelize, qi) {
      const departments = await qi.describeTable('Departments');
      ok(!('allowence' in departments), 'the allowence column must be gone');
      ok('allowance' in departments, 'the allowance column must exist');

      const rows = await select(sequelize, 'SELECT name, allowance, include_public_holidays FROM Departments WHERE id = 1');
      equal(rows.length, 1, 'the department row survived the rename/rebuild');
      equal(rows[0].name, 'Sales', 'department name preserved');
      equal(Number(rows[0].allowance), 5, 'the allowence VALUE was carried into allowance');
      equal(Number(rows[0].include_public_holidays), 1, 'other columns carried through the copy');
    },
  },

  '20171219-allowance-adjustment-per-year.js': {
    seed: async function(qi) {
      await qi.bulkInsert('Companies', [companyRow()]);
      await qi.bulkInsert('Users', [
        {
          id: 1,
          email: 'ann@example.com',
          password: 'legacy-hash',
          name: 'Ann',
          lastname: 'Smith',
          activated: true,
          admin: false,
          start_date: '2015-01-01',
          createdAt: NOW,
          updatedAt: NOW,
          adjustment: 3,
        },
        {
          id: 2,
          email: 'bob@example.com',
          password: 'legacy-hash',
          name: 'Bob',
          lastname: 'Jones',
          activated: true,
          admin: false,
          start_date: '2016-01-01',
          createdAt: NOW,
          updatedAt: NOW,
          adjustment: -1,
        },
      ]);
    },
    assert: async function(sequelize) {
      const rows = await select(sequelize,
        'SELECT year, adjustment, user_id, created_at FROM user_allowance_adjustment ORDER BY user_id');
      equal(rows.length, 2, 'one adjustment row per user was backfilled');
      equal(Number(rows[0].year), 2017, 'backfill year is 2017');
      equal(Number(rows[0].adjustment), 3, "Ann's adjustment value moved into the new table");
      equal(Number(rows[0].user_id), 1, 'row linked to user 1');
      equal(Number(rows[1].adjustment), -1, "Bob's negative adjustment moved verbatim");
      equal(Number(rows[1].user_id), 2, 'row linked to user 2');
      ok(rows.every(row => row.created_at !== null && row.created_at !== ''),
        'backfilled created_at is populated on every row');
    },
  },

  '20171220-drop-adjustment-column-from-user.js': {
    seed: async function(qi) {
      await qi.bulkInsert('Companies', [companyRow()]);
      await qi.bulkInsert('Users', [{
        id: 1,
        email: 'carol@example.com',
        password: 'secret-hash',
        name: 'Carol',
        lastname: 'White',
        activated: true,
        admin: true,
        start_date: '2015-06-01',
        createdAt: NOW,
        updatedAt: NOW,
        companyId: 1,
        adjustment: 7,
      }]);
    },
    assert: async function(sequelize, qi) {
      const users = await qi.describeTable('Users');
      ok(!('adjustment' in users), 'the adjustment column is dropped');

      const rows = await select(sequelize,
        'SELECT email, password, name, lastname, admin FROM Users WHERE id = 1');
      equal(rows.length, 1, 'the user row survived the rebuild that dropped the column');
      equal(rows[0].email, 'carol@example.com', 'email preserved');
      equal(rows[0].password, 'secret-hash', 'password preserved');
      equal(rows[0].name, 'Carol', 'name preserved');
      equal(rows[0].lastname, 'White', 'lastname preserved');
    },
  },

  '20190118-chnage-type-value-for-api-token.js': {
    seed: async function(qi) {
      await qi.bulkInsert('Companies', [
        companyRow({ integration_api_token: '2deff8f2-38e5-43f9-a71e-7a239af1cf73' }),
      ]);
    },
    assert: async function(sequelize) {
      const rows = await select(sequelize,
        'SELECT name, integration_api_token FROM Companies WHERE id = 1');
      equal(rows.length, 1, 'the company row survived');
      equal(rows[0].name, 'ACME Ltd', 'company name preserved');
      equal(String(rows[0].integration_api_token), '2deff8f2-38e5-43f9-a71e-7a239af1cf73',
        'the token value is preserved verbatim whichever branch runs (sqlite stands down via the current-model guard, other dialects are a no-op)');
    },
  },

  '20191030-compress-email-audit.js': {
    // This migration rewrites through the lib/model/db singleton, so the
    // case database IS the singleton's database: the parent binds the
    // child env to this case's storage/database before anything is
    // required, and this scenario grabs the singleton as its sequelize.
    usesModelSingleton: true,
    seed: async function(qi) {
      await qi.bulkInsert('EmailAudit', [
        {
          id: 1,
          user_id: 1,
          email: 'hr@example.com',
          subject: 'Leave request approved',
          body: '<html><body><p>Hello&nbsp;there, your leave was approved.</p></body></html>',
          status: 'sent',
          created_at: NOW,
        },
        {
          id: 2,
          user_id: 1,
          email: 'hr@example.com',
          subject: 'Already plain',
          body: 'Plain text body that must not change.',
          status: 'sent',
          created_at: NOW,
        },
      ]);
    },
    assert: async function(sequelize) {
      const rows = await select(sequelize,
        'SELECT email, subject, body FROM EmailAudit ORDER BY id');
      equal(rows.length, 2, 'both audit rows survived');
      equal(rows[0].email, 'hr@example.com', 'email preserved');
      equal(rows[0].subject, 'Leave request approved', 'subject preserved');
      ok(!String(rows[0].body).includes('<'), 'HTML body was converted: no tags remain');
      ok(String(rows[0].body).includes('Hello'), 'converted body keeps the text content');
      equal(String(rows[1].body), 'Plain text body that must not change.',
        'an already-plain body is not mangled');
    },
  },

  '20260627130000-encrypt-sso-client-secret.js': {
    seed: async function(qi) {
      await qi.bulkInsert('Companies', [
        companyRow({
          sso_auth_config: JSON.stringify({
            client_secret: 'sso-client-secret-plaintext',
            discovery_url: 'https://idp.example.com/.well-known/openid-configuration',
          }),
        }),
        Object.assign(companyRow({ id: 2, name: 'No SSO Ltd' }), { sso_auth_config: '' }),
      ]);
    },
    assert: async function(sequelize) {
      const secretStore = require('../../lib/secret_store');
      const rows = await select(sequelize,
        'SELECT id, sso_auth_config FROM Companies ORDER BY id');
      equal(rows.length, 2, 'both companies present');

      const config = JSON.parse(rows[0].sso_auth_config);
      ok(String(config.client_secret).startsWith('enc:v1:aes-256-gcm:'),
        'the plaintext client secret was rewritten to the encrypted envelope format');
      equal(secretStore.decryptSecret(config.client_secret), 'sso-client-secret-plaintext',
        'the ciphertext decrypts back to the original secret with the configured key');
      equal(config.discovery_url, 'https://idp.example.com/.well-known/openid-configuration',
        'sibling config keys survive the rewrite');

      equal(rows[1].sso_auth_config, '', 'an empty config row is left untouched');
    },
  },

  '20260701150000-localize-existing-kz-ru-companies.js': {
    seed: async function(qi) {
      await qi.bulkInsert('Companies', [companyRow({ country: 'RU' })]);
      await qi.bulkInsert('Departments', [{
        id: 1, name: 'Sales', companyId: 1, createdAt: NOW, updatedAt: NOW,
      }]);
      await qi.bulkInsert('LeaveTypes', [
        { id: 1, name: 'Holiday', companyId: 1, createdAt: NOW, updatedAt: NOW },
        { id: 2, name: 'Sick Leave', companyId: 1, createdAt: NOW, updatedAt: NOW },
      ]);
      await qi.bulkInsert('BankHolidays', [
        // Untouched English default on a 2026 rename-map date.
        { id: 1, companyId: 1, name: 'New Year Holidays', date: '2026-01-01', createdAt: NOW, updatedAt: NOW },
        // A customized holiday on a rename-map date: the exact-match
        // predicate must leave it alone (the data-safety surface).
        { id: 2, companyId: 1, name: 'Наш особенный день', date: '2026-03-08', createdAt: NOW, updatedAt: NOW },
      ]);
    },
    assert: async function(sequelize) {
      const companies = await select(sequelize, 'SELECT date_format FROM Companies WHERE id = 1');
      equal(companies[0].date_format, 'DD.MM.YYYY', 'RU date format localized');

      const departments = await select(sequelize, 'SELECT name FROM Departments WHERE id = 1');
      equal(departments[0].name, 'Продажи', 'default department name localized');

      const leaveTypes = await select(sequelize, 'SELECT name FROM LeaveTypes ORDER BY id');
      deepEqual(leaveTypes.map(row => row.name), ['Отпуск', 'Больничный'],
        'default leave-type names localized');

      const holidays = await select(sequelize,
        'SELECT name, date FROM BankHolidays WHERE companyId = 1 ORDER BY date');
      const byDate = {};
      holidays.forEach(row => {
        byDate[String(row.date).slice(0, 10)] = byDate[String(row.date).slice(0, 10)] || [];
        byDate[String(row.date).slice(0, 10)].push(row.name);
      });
      equal(byDate['2026-01-01'][0], 'Новогодние каникулы',
        'untouched English 2026 holiday renamed to Russian');
      equal(byDate['2026-03-08'][0], 'Наш особенный день',
        'a customized holiday on a rename-map date is NOT rewritten');
      ok((byDate['2027-01-01'] || []).indexOf('Новогодние каникулы') !== -1,
        'the 2027 holiday set was added');
    },
  },

  '20260707100000-hash-integration-api-tokens.js': {
    seed: async function(qi) {
      await qi.bulkInsert('Companies', [
        companyRow({ integration_api_token: '2deff8f2-38e5-43f9-a71e-7a239af1cf73' }),
        companyRow({ id: 2, name: 'Tokenless Ltd' }),
      ]);
    },
    assert: async function(sequelize) {
      const tokenSecurity = require('../../lib/auth/integration_api_token');
      const rows = await select(sequelize,
        'SELECT id, integration_api_token, integration_api_token_hash FROM Companies ORDER BY id');
      equal(rows.length, 2, 'both companies present');

      equal(rows[0].integration_api_token, null, 'the plaintext token column is nulled');
      equal(String(rows[0].integration_api_token_hash),
        tokenSecurity.hashToken('2deff8f2-38e5-43f9-a71e-7a239af1cf73'),
        'the stored hash is the SHA-256 of the exact plaintext token');

      equal(rows[1].integration_api_token_hash === null, false,
        'the tokenless company got a backfilled hash (NOT NULL survives the upgrade)');
      ok(/^[a-f0-9]{64}$/.test(String(rows[1].integration_api_token_hash)),
        'the backfilled hash keeps the 64-hex shape');
      ok(String(rows[1].integration_api_token_hash) !== tokenSecurity.hashToken(''),
        'the backfilled hash matches no presentable empty token');
    },
  },

  '20260803120000-purge-credential-audit-rows.js': {
    seed: async function(qi) {
      await qi.bulkInsert('audit', [
        {
          entityType: 'USER', entityId: 1, attribute: 'password',
          oldValue: 'legacy-md5-hash', newValue: 'scrypt-hash', at: NOW,
        },
        {
          entityType: 'USER', entityId: 1, attribute: 'name',
          oldValue: 'Ann', newValue: 'Anya', at: NOW,
        },
      ]);
    },
    assert: async function(sequelize) {
      const passwordRows = await select(sequelize,
        "SELECT COUNT(*) AS c FROM audit WHERE attribute = 'password'");
      equal(Number(passwordRows[0].c), 0, 'the credential (password) audit rows are purged');

      const nameRows = await select(sequelize,
        "SELECT oldValue, newValue FROM audit WHERE attribute = 'name'");
      equal(nameRows.length, 1, 'the innocent audit row survives the purge');
      equal(nameRows[0].oldValue, 'Ann', 'surviving row intact');
      equal(nameRows[0].newValue, 'Anya', 'surviving row intact');
    },
  },
};

// ---------------------------------------------------------------------------
// The D-09 negative half, shared by every case: an EMPTY database that
// bootstrapEmptyDatabase syncs carries no migrator meta rows - the
// detection that a sync-built schema can never masquerade as applied
// migrations. Runs on its own fresh database, never the case database.
// ---------------------------------------------------------------------------

async function syncBaselineCarriesNoMetaRows() {
  let negSequelize;
  let negStorage;

  if (dialect === 'mysql') {
    // The case connection can create the sibling database the negative
    // control runs on; the parent drops it afterwards with the case db.
    negStorage = null;
  } else {
    negStorage = path.join(storageDir, caseSlugBase + '_neg.sqlite');
    if (fs.existsSync(negStorage)) {
      fs.unlinkSync(negStorage);
    }
  }

  try {
    if (dialect === 'mysql') {
      const maintenance = new Sequelize(connectionOptions(process.env.DB_NAME));
      await maintenance.query('CREATE DATABASE IF NOT EXISTS `' + negDbName + '`');
      await maintenance.close();
      negSequelize = new Sequelize(connectionOptions(negDbName));
    } else {
      negSequelize = new Sequelize(connectionOptions(negStorage));
    }

    // Minimal models over the required base tables: bootstrapEmptyDatabase
    // syncs whatever models are registered, and the point under proof is
    // what sync writes into the META table, not the schema shape.
    ['Companies', 'Departments', 'LeaveTypes', 'Users', 'schedule'].forEach(function(name) {
      negSequelize.define(name, { name: Sequelize.STRING }, { tableName: name });
    });

    const bootstrapped = await migrator.bootstrapEmptyDatabase(negSequelize);
    equal(bootstrapped, true, 'the empty negative-control database was sync-bootstrapped');

    const tables = (await negSequelize.getQueryInterface().showAllTables())
      .map(function(t) { return typeof t === 'string' ? t : (t && (t.tableName || t.name)); });
    if (tables.indexOf('SequelizeMeta') !== -1) {
      const metaRows = await select(negSequelize, 'SELECT name FROM SequelizeMeta');
      equal(metaRows.length, 0,
        'D-09 negative half: a sync-bootstrapped empty database carries no migrator meta rows');
    } else {
      ok(true, 'D-09 negative half: the sync-bootstrapped database has no SequelizeMeta table at all');
    }
  } finally {
    if (negSequelize) {
      await negSequelize.close();
    }
    if (dialect === 'mysql') {
      const maintenance = new Sequelize(connectionOptions(process.env.DB_NAME));
      await maintenance.query('DROP DATABASE IF EXISTS `' + negDbName + '`');
      await maintenance.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  const migrationFile = process.argv[2];
  const entry = MANIFEST.migrations.find(function(e) {
    return path.basename(e.migration) === migrationFile;
  });
  ok(entry, 'the case migration is a manifest entry: ' + migrationFile);

  const scenario = SCENARIOS[migrationFile];
  ok(scenario, 'the case has a scenario: ' + migrationFile);

  const files = fs.readdirSync(CORE_HISTORY).filter(f => f.endsWith('.js')).sort();
  const index = files.indexOf(migrationFile);
  ok(index !== -1, 'the case migration is in the core history');
  const expectedMetaCount = index + 1;

  let sequelize;
  let singletonDb = null;

  if (scenario.usesModelSingleton) {
    singletonDb = require('../../lib/model/db');
    sequelize = singletonDb.sequelize;
  } else if (dialect === 'mysql') {
    sequelize = new Sequelize(connectionOptions(process.env.DB_NAME));
  } else {
    sequelize = new Sequelize(connectionOptions(path.join(storageDir, caseSlugBase + '.sqlite')));
  }

  const queryInterface = sequelize.getQueryInterface();

  try {
    await createOriginalBase(queryInterface);

    // 1..N-1 through the migrator's own machinery, real history directory.
    if (index > 0) {
      const umzugBefore = migrator.createUmzug(sequelize, Sequelize, CORE_HISTORY);
      await umzugBefore.up({ to: files[index - 1] });
    }

    await scenario.seed(queryInterface, sequelize);

    // N the same way - the only remaining bound is N itself.
    const umzugCase = migrator.createUmzug(sequelize, Sequelize, CORE_HISTORY);
    await umzugCase.up({ to: migrationFile });

    await scenario.assert(sequelize, queryInterface);

    // Dual proof, first half: the meta table carries exactly 1..N,
    // N included - N ran as a migration, not as part of a sync baseline.
    const metaRows = await select(sequelize, 'SELECT name FROM SequelizeMeta ORDER BY name');
    equal(metaRows.length, expectedMetaCount,
      'the meta table carries exactly the applied migrations 1..N');
    const metaNames = metaRows.map(function(row) { return row.name; });
    ok(metaNames.indexOf(migrationFile) !== -1,
      'D-09 positive half: the meta table contains the record for N (' + migrationFile + ')');

    // Dual proof, second half (negative): sync bootstrap writes no meta.
    await syncBaselineCarriesNoMetaRows();
  } finally {
    // For singleton scenarios sequelize IS singletonDb.sequelize - close
    // it exactly once.
    await sequelize.close();
  }

  // The verdict the parent asserts on. jsonable facts only.
  process.stdout.write('\n' + JSON.stringify({
    ok: true,
    migration: migrationFile,
    dialect: dialect,
    assertions: state.assertions,
  }) + '\n');
  process.exit(0);
}

// Only a spawn runs the case: a require (e.g. mocha loading the tree, or
// the dialect-sensitive manifest listing exercising the spec) must not
// execute anything.
if (require.main === module) {
  main().catch(function(error) {
    process.stderr.write(String((error && error.stack) || error) + '\n');
    process.exit(1);
  });
}
