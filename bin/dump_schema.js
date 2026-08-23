'use strict';

// Read-only database schema dump for release-confidence checks.
//
// Prints a deterministic representation of the CURRENT database schema:
//   - MySQL : SHOW CREATE TABLE for every table (AUTO_INCREMENT counter stripped);
//   - SQLite: the CREATE statements from sqlite_master.
// It also lists the applied migrations recorded in SequelizeMeta.
//
// It does NOT modify the database. Intended for:
//   - CI idempotency diffs (dump after run #1 vs run #2 must be identical);
//   - offline comparison of a fresh sync+baseline schema against a reference /
//     production schema (export both with this tool and `diff` them).
//
// Usage: node bin/dump_schema.js   (uses the same DB_* env vars as db_update.js)

const db = require('../lib/model/db');

// Keep the dump clean: silence Sequelize query logging so only schema goes to
// stdout (the output is meant to be diffed/compared verbatim).
db.sequelize.options.logging = false;

function normalize(sql) {
  return String(sql || '')
    // The AUTO_INCREMENT counter depends on inserted rows, not on schema shape.
    .replace(/ AUTO_INCREMENT=\d+/g, '')
    .trim();
}

function dumpMysqlTable(name) {
  return db.sequelize.query('SHOW CREATE TABLE `' + name + '`').then(function (res) {
    const row = res[0][0] || {};
    // eslint-disable-next-line no-console
    console.log('-- ' + name);
    // eslint-disable-next-line no-console
    console.log(normalize(row['Create Table'] || row['Create View']) + ';');
    // eslint-disable-next-line no-console
    console.log('');
  });
}

function dumpSqliteTable(name) {
  return db.sequelize
    .query('SELECT sql FROM sqlite_master WHERE name = ? AND sql IS NOT NULL', {
      replacements: [name],
    })
    .then(function (res) {
      // eslint-disable-next-line no-console
      console.log('-- ' + name);
      (res[0] || []).forEach(function (r) {
        // eslint-disable-next-line no-console
        console.log(normalize(r.sql) + ';');
      });
      // eslint-disable-next-line no-console
      console.log('');
    });
}

function dumpAppliedMigrations() {
  return db.sequelize
    .query('SELECT name FROM SequelizeMeta ORDER BY name ASC')
    .then(function (res) {
      // eslint-disable-next-line no-console
      console.log('-- Applied migrations:');
      (res[0] || []).forEach(function (r) {
        // eslint-disable-next-line no-console
        console.log('--   ' + r.name);
      });
    })
    .catch(function () {
      // No SequelizeMeta table (e.g. nothing migrated yet) is not an error here.
      // eslint-disable-next-line no-console
      console.log('-- (no SequelizeMeta table found)');
    });
}

db.connect()
  .then(function () {
    const queryInterface = db.sequelize.getQueryInterface();
    const dialect = db.sequelize.getDialect();

    return queryInterface.showAllTables().then(function (tables) {
      const names = (tables || [])
        .map(function (t) {
          return typeof t === 'string' ? t : (t.tableName || t.name);
        })
        .filter(Boolean)
        .sort();

      const dumpOne = dialect === 'mysql' ? dumpMysqlTable : dumpSqliteTable;

      return names
        .reduce(function (chain, name) {
          return chain.then(function () {
            return dumpOne(name);
          });
        }, Promise.resolve())
        .then(dumpAppliedMigrations);
    });
  })
  .then(function () {
    return db.sequelize.close();
  })
  .catch(function (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to dump schema:', error && error.stack || String(error));
    process.exit(1);
  });
