'use strict';

/*
  queryInterface.createTable takes a table name, the attributes, and an options
  object - and it does not read an `indexes` key out of that object. Passing one
  is not an error and produces no warning; the table is created and the indexes
  simply are not.

  Two migrations did that, one in each edition. Proven rather than argued:

    await createTable('ConflictRules', {...}, {indexes: [...4 of them...]})
    showIndex('ConflictRules') -> []

  It stays hidden because the models declare the same indexes and
  sequelize.sync(), which every test run uses, does create them. So they exist
  in every database the suite has ever seen and in none that holds real data.

  In the premium edition that cost the conflict rules their uniqueness, since
  the route relied on the constraint and answered
  SequelizeUniqueConstraintError. Here it cost only the plain indexes, because
  both reminder-schedule handlers check for a duplicate themselves.

  The shape is what this file is for. Writing indexes next to the columns they
  belong to reads perfectly well, and nothing about it says the indexes will not
  be there.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');

/*
  This edition's migrations only. Reaching into a premium checkout from here
  would pass in CI, which has no such checkout, and fail on a machine that does
  - a test that disagrees with itself depending on what is on disk beside it.
  The premium edition carries its own copy of this rule.
*/
const migrationsDir = path.join(root, 'migrations');

const migrations = fs.readdirSync(migrationsDir)
  .filter(name => name.endsWith('.js'))
  .map(name => ({path: path.join(migrationsDir, name), name}));

/*
  The options argument of a createTable call, matched by walking the brackets
  rather than by a regular expression: these calls span a hundred lines and
  contain every kind of nesting.
*/
const createTableOptions = source => {
  const calls = [];
  const pattern = /createTable\(/g;
  let match;

  while ((match = pattern.exec(source))) {
    const argsStart = match.index + match[0].length;
    let cursor = argsStart - 1;
    let depth = 0;

    while (cursor < source.length) {
      if (source[cursor] === '(') {
        depth++;
      } else if (source[cursor] === ')') {
        depth--;
        if (depth === 0) {
          break;
        }
      }
      cursor++;
    }

    calls.push(source.slice(argsStart, cursor));
  }

  return calls;
};

describe('Migrations and their indexes', function() {

  it('has migrations to check', function() {
    expect(migrations.length).to.be.above(10);
  });

  it('never hands an indexes option to createTable', function() {
    const offenders = migrations.filter(migration => createTableOptions(
      fs.readFileSync(migration.path, 'utf8')
    ).some(args => /\bindexes\s*:/.test(args)));

    expect(offenders.map(migration => migration.name)).to.deep.equal(
      [],
      'createTable ignores that option, so these indexes are declared and never created'
    );
  });

  /*
    And the assertion above passes just as well if createTable is never called,
    so the calls it was written about have to still be there.
  */
  it('still has createTable calls to have checked', function() {
    const withCreateTable = migrations.filter(migration => createTableOptions(
      fs.readFileSync(migration.path, 'utf8')
    ).length > 0);

    expect(withCreateTable.length).to.be.above(3);
  });

  /*
    The two follow-ups that put the missing indexes back. Named individually
    because a database that has already run the originals gets its indexes from
    nowhere else.
  */
  it('creates the reminder schedule indexes in a follow-up', function() {
    const followUp = migrations.find(migration => /index-reminder-schedules/.test(migration.name));

    expect(followUp, 'the follow-up migration is gone').to.not.equal(undefined);

    const source = fs.readFileSync(followUp.path, 'utf8');

    ['reminder_schedules_company_active', 'reminder_schedules_leave_type', 'reminder_schedules_days_before']
      .forEach(name => expect(source).to.include(name));
    expect(source).to.include('addIndex');
  });
});
