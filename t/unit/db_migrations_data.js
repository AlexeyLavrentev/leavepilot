'use strict';

/*
  Plan 05-06 (QUAL-03): every data-rewriting migration proven on the state
  that existed before it (D-08), with the dual migration-not-sync proof
  (D-09), synthetic rows (D-11), per-case fresh schemas (Pitfall 7).

  The list of cases is NOT hand-duplicated here: this spec iterates
  t/fixtures/data-rewriting-migrations.json, and t/unit/
  data_rewriting_migrations.js (the D-10 companion gate) re-derives that
  manifest from the migration sources on every run - the coverage and the
  manifest cannot drift apart.

  Each case runs in a dedicated child process (t/lib/
  db_migrations_data_case.js): the case's 1..N-1 replay executes every
  earlier data-rewriting migration too, and one of them (20191030 compress
  email audit) writes through the lib/model/db models SINGLETON, which
  binds its connection from the environment at require time. Per-case
  database isolation is therefore only possible with a fresh process per
  case (T-05-17: no shared databases). The child:

    - builds the minimal original-shape base (the pre-migration-1 sync
      stand-in) on a fresh per-case schema - a sqlite temp file, or a
      per-case MySQL database whose name is derived from the migration;
    - replays migrations 1..N-1 through lib/model/migrator.js exports
      (createUmzug over the real history directory; umzug's native { to }
      bound on the migrator-built instance, whose adapter/storage are the
      migrator's own - the spec never constructs umzug machinery itself);
    - seeds the scenario's synthetic rows, executes N, and asserts the
      transformed data (values, not counts) plus both halves of the D-09
      proof: SequelizeMeta contains exactly 1..N including N, while a
      sync-bootstrapped empty database carries no meta rows at all.

  Dialects: the child reads DB_DIALECT the same way the app does. SQLite is
  the unit-contour default; under the MySQL dialect contour (bin/test.js
  with TEST_DB_DIALECT=mysql, plan 05-05) this spec creates one database
  per case (plus its negative-control sibling) through a maintenance
  connection and drops them afterwards - container sharing, not database
  sharing.
*/

const expect = require('chai').expect;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const manifest = require('../fixtures/data-rewriting-migrations.json');
const Sequelize = require('sequelize');

const ROOT = path.join(__dirname, '..', '..');
const CASE_SCRIPT = path.join(ROOT, 't', 'lib', 'db_migrations_data_case.js');
const CHILD_TIMEOUT_MS = 120000;

const dialect = process.env.DB_DIALECT === 'mysql' ? 'mysql' : 'sqlite';

function slugFor(migrationFile) {
  return migrationFile
    .replace(/\.js$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(-40);
}

function mysqlDatabaseName(slug) {
  return 'lp_migr_' + slug.toLowerCase();
}

function runCaseChild(migrationFile, env) {
  return new Promise(function(resolve) {
    const child = spawn(process.execPath, [CASE_SCRIPT, migrationFile], {
      env: env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(function() {
      child.kill('SIGKILL');
    }, CHILD_TIMEOUT_MS);

    const finish = function(code, killed) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code: code, killed: !!killed, stdout: stdout, stderr: stderr });
    };

    child.stdout.on('data', function(chunk) {
      stdout += chunk;
    });
    child.stderr.on('data', function(chunk) {
      stderr += chunk;
    });
    child.on('error', function(error) {
      stderr += String(error);
      finish(1);
    });
    child.on('exit', function(code, signal) {
      finish(code, signal === 'SIGKILL');
    });
  });
}

function lastJsonLine(stdout) {
  const lines = stdout.split('\n').filter(function(line) {
    return line.trim().length > 0;
  });
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{')) {
      return JSON.parse(lines[i]);
    }
  }
  throw new Error('the case child printed no JSON verdict line. stdout:\n' + stdout);
}

manifest.migrations.forEach(function(entry) {
  const migrationFile = path.basename(entry.migration);
  const slug = slugFor(migrationFile);

  describe('data-rewriting replay: ' + migrationFile, function() {
    this.timeout(180000);

    let storageDir;
    let maintenance;

    before(function() {
      if (dialect === 'mysql') {
        maintenance = new Sequelize(
          process.env.DB_NAME || 'lp_test',
          process.env.DB_USER,
          process.env.DB_PASSWORD,
          {
            host: process.env.DB_HOST || '127.0.0.1',
            port: process.env.DB_PORT || '3306',
            dialect: 'mysql',
            logging: false,
          }
        );
      } else {
        storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-migrations-data-'));
      }
    });

    after(async function() {
      if (maintenance) {
        await maintenance.query('DROP DATABASE IF EXISTS `' + mysqlDatabaseName(slug) + '`');
        await maintenance.query('DROP DATABASE IF EXISTS `' + mysqlDatabaseName(slug) + '_neg`');
        await maintenance.close();
      } else if (storageDir) {
        fs.rmSync(storageDir, { recursive: true, force: true });
      }
    });

    it('proves N on the replayed 1..N-1 pre-state (dual migration-not-sync proof)', async function() {
      // Per-case env: the child's model singleton (if a scenario needs it)
      // and its Sequelize both land on the case database.
      const env = Object.assign({}, process.env, {
        DB_DIALECT: dialect,
        CASE_SLUG: slug,
        CASE_STORAGE_DIR: storageDir || '',
        CASE_NEG_DB: mysqlDatabaseName(slug) + '_neg',
      });

      if (dialect === 'mysql') {
        env.DB_NAME = mysqlDatabaseName(slug);
        await maintenance.query('CREATE DATABASE IF NOT EXISTS `' + env.DB_NAME + '`');
      } else {
        env.DB_STORAGE = path.join(storageDir, slug + '.sqlite');
      }

      // Deterministic key material for the encryption-backfill case; the
      // child derives the same key through lib/secret_store.
      env.CRYPTO_SECRET = 'plan-05-06-replay-crypto-secret';

      const result = await runCaseChild(migrationFile, env);

      expect(
        result.killed,
        'the case child was killed after ' + CHILD_TIMEOUT_MS + 'ms - a hung replay, not a verdict'
      ).to.equal(false);
      expect(
        result.code,
        'the case child failed for ' + migrationFile + ':\n' + result.stderr
      ).to.equal(0);

      const verdict = lastJsonLine(result.stdout);
      expect(verdict.ok, 'the case child must report ok').to.equal(true);
      expect(verdict.migration).to.equal(migrationFile);
      expect(verdict.dialect).to.equal(dialect);
      expect(
        verdict.assertions,
        'the case child ran suspiciously few assertions - the scenario may have silently skipped its asserts'
      ).to.be.at.least(8);
    });
  });
});
