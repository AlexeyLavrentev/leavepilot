'use strict';

const expect = require('chai').expect;
const fs = require('fs');
const os = require('os');
const path = require('path');
const Sequelize = require('sequelize');
const migrator = require('../../lib/model/migrator');

function writeMigration(dir, name, lines) {
  fs.writeFileSync(path.join(dir, name), lines.join('\n'));
}

const ADD_BAR_MIGRATION = [
  "'use strict';",
  'module.exports = {',
  '  up: function(queryInterface, Sequelize) {',
  "    return queryInterface.addColumn('Foos', 'bar', { type: Sequelize.STRING });",
  '  },',
  '  down: function(queryInterface) {',
  "    return queryInterface.removeColumn('Foos', 'bar');",
  '  },',
  '};',
];

const CREATE_BAZ_MIGRATION = [
  "'use strict';",
  'module.exports = {',
  '  up: function(queryInterface, Sequelize) {',
  "    return queryInterface.createTable('Bazes', {",
  '      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },',
  '    });',
  '  },',
  '  down: function(queryInterface) {',
  "    return queryInterface.dropTable('Bazes');",
  '  },',
  '};',
];

// Real-history-style guards: the historical migrations check what already
// exists before acting, which is what lets them run (or safely no-op) on
// the partially-built databases the D-12 cases below construct.
const GUARDED_ADD_BAR_MIGRATION = [
  "'use strict';",
  'module.exports = {',
  '  up: function(queryInterface, Sequelize) {',
  "    return queryInterface.describeTable('Foos').then(function(attributes) {",
  "      if (attributes.hasOwnProperty('bar')) { return 1; }",
  "      return queryInterface.addColumn('Foos', 'bar', { type: Sequelize.STRING });",
  '    });',
  '  },',
  '  down: function(queryInterface) {',
  "    return queryInterface.removeColumn('Foos', 'bar');",
  '  },',
  '};',
];

const GUARDED_CREATE_BAZ_MIGRATION = [
  "'use strict';",
  'module.exports = {',
  '  up: function(queryInterface, Sequelize) {',
  '    return queryInterface.showAllTables().then(function(tables) {',
  "      if (tables.indexOf('Bazes') !== -1) { return 1; }",
  "      return queryInterface.createTable('Bazes', {",
  '        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },',
  '      });',
  '    });',
  '  },',
  '  down: function(queryInterface) {',
  "    return queryInterface.dropTable('Bazes');",
  '  },',
  '};',
];

describe('lib/model/db/migrator', function() {
  let migrationsDir;
  let sequelize;

  beforeEach(function() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-'));
    migrationsDir = path.join(tmpDir, 'migrations');
    fs.mkdirSync(migrationsDir);

    sequelize = new Sequelize('sqlite::memory:', { logging: false });
    // The model already contains the column that a historical migration adds,
    // exactly like the real app (sync() builds the current schema).
    sequelize.define('Foo', { bar: Sequelize.STRING }, { tableName: 'Foos' });
  });

  afterEach(function() {
    return sequelize.close();
  });

  function runMigrator() {
    return migrator.run({
      sequelize: sequelize,
      Sequelize: Sequelize,
      migrationPaths: [migrationsDir],
      requiredBaseTables: ['Foos'],
    });
  }

  it('fresh install: syncs schema and baselines migrations without running them', function() {
    writeMigration(migrationsDir, '001-add-bar.js', ADD_BAR_MIGRATION);

    // If the migration ran, addColumn('bar') would crash (column already exists
    // from sync()). Resolving cleanly proves it was baselined, not executed.
    return runMigrator().then(function(result) {
      expect(result.bootstrapped).to.equal(true);
      expect(result.baselined).to.include('001-add-bar.js');
      return sequelize.getQueryInterface().describeTable('Foos');
    }).then(function(columns) {
      expect(columns).to.have.property('bar');
    });
  });

  it('repeated run on an already-initialised database is a safe no-op', function() {
    writeMigration(migrationsDir, '001-add-bar.js', ADD_BAR_MIGRATION);

    return runMigrator().then(function() {
      return runMigrator();
    }).then(function(result) {
      expect(result.bootstrapped).to.equal(false);
      expect(result.applied).to.deep.equal([]);
    });
  });

  it('applies genuinely new migrations on an established database', function() {
    writeMigration(migrationsDir, '001-add-bar.js', ADD_BAR_MIGRATION);

    return runMigrator().then(function() {
      // A later release ships a brand-new migration.
      writeMigration(migrationsDir, '002-create-baz.js', CREATE_BAZ_MIGRATION);
      return runMigrator();
    }).then(function(result) {
      expect(result.bootstrapped).to.equal(false);
      expect(result.applied).to.include('002-create-baz.js');
      return sequelize.getQueryInterface().showAllTables();
    }).then(function(tables) {
      const names = tables.map(function(t) {
        return typeof t === 'string' ? t : t.tableName;
      });
      expect(names).to.include('Bazes');
    });
  });

  // ---------------------------------------------------------------------
  // D-12 (plan 05-06): the half-migrated bootstrap fold. A PARTIAL base -
  // some required tables present, some missing - is the residue of an
  // interrupted bootstrap or a crashed historical upgrade. It must not be
  // treated as established (sync + baseline over residue silently marks
  // the owed migrations applied without running them - silent data loss).
  // ---------------------------------------------------------------------

  describe('half-migrated bootstrap (D-12)', function() {
    let halfSequelize;
    let halfMigrationsDir;

    function runHalfMigrator() {
      return migrator.run({
        sequelize: halfSequelize,
        Sequelize: Sequelize,
        migrationPaths: [halfMigrationsDir],
        requiredBaseTables: ['Foos', 'Bazes'],
      });
    }

    function writeGuardedHistory() {
      writeMigration(halfMigrationsDir, '001-add-bar.js', GUARDED_ADD_BAR_MIGRATION);
      writeMigration(halfMigrationsDir, '002-create-baz.js', GUARDED_CREATE_BAZ_MIGRATION);
    }

    beforeEach(function() {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-half-'));
      halfMigrationsDir = path.join(tmpDir, 'migrations');
      fs.mkdirSync(halfMigrationsDir);

      halfSequelize = new Sequelize('sqlite::memory:', { logging: false });
      halfSequelize.define('Foo', { bar: Sequelize.STRING }, { tableName: 'Foos' });
      halfSequelize.define('Baz', {}, { tableName: 'Bazes' });
    });

    afterEach(function() {
      return halfSequelize.close();
    });

    it('a partial base is NOT established: missing migrations are applied, not baselined', function() {
      writeGuardedHistory();

      // Half-migrated: Foos exists (its 001 migration never recorded), the
      // Bazes base table is missing entirely.
      return halfSequelize.getQueryInterface().createTable('Foos', {
        id: { type: Sequelize.INTEGER, primaryKey: true },
        name: Sequelize.STRING,
      }).then(function() {
        return runHalfMigrator();
      }).then(function(result) {
        expect(result.bootstrapped).to.equal(false);
        expect(result.baselined).to.deep.equal([]);
        expect(result.applied).to.include('001-add-bar.js');
        expect(result.applied).to.include('002-create-baz.js');
      });
    });

    it('after the half-migrated repair the meta table carries the applied migrations', function() {
      writeGuardedHistory();
      let repair;

      return halfSequelize.getQueryInterface().createTable('Foos', {
        id: { type: Sequelize.INTEGER, primaryKey: true },
        name: Sequelize.STRING,
      }).then(function() {
        return runHalfMigrator();
      }).then(function(result) {
        repair = result;
        return halfSequelize.query('SELECT name FROM SequelizeMeta', {
          type: Sequelize.QueryTypes.SELECT,
        });
      }).then(function(metaRows) {
        // Baseline writes meta rows too - the load-bearing half is that
        // these rows record EXECUTED migrations, i.e. the repair reported
        // them applied rather than baselined over the gap.
        expect(repair.baselined).to.deep.equal([]);
        const names = metaRows.map(function(row) { return row.name; });
        expect(names).to.include('001-add-bar.js');
        expect(names).to.include('002-create-baz.js');
      });
    });

    it('a fully-based database with no meta rows still takes the established path', function() {
      writeGuardedHistory();

      const queryInterface = halfSequelize.getQueryInterface();
      return queryInterface.createTable('Foos', {
        id: { type: Sequelize.INTEGER, primaryKey: true },
        name: Sequelize.STRING,
      }).then(function() {
        return queryInterface.createTable('Bazes', {
          id: { type: Sequelize.INTEGER, primaryKey: true },
        });
      }).then(function() {
        return runHalfMigrator();
      }).then(function(result) {
        expect(result.bootstrapped).to.equal(false);
        expect(result.baselined).to.deep.equal([]);
        expect(result.applied).to.include('001-add-bar.js');
        expect(result.applied).to.include('002-create-baz.js');
      });
    });

    it('an empty database still bootstraps via sync exactly as today', function() {
      writeGuardedHistory();

      return runHalfMigrator().then(function(result) {
        expect(result.bootstrapped).to.equal(true);
        expect(result.baselined).to.include('001-add-bar.js');
        expect(result.baselined).to.include('002-create-baz.js');
        expect(result.applied).to.deep.equal([]);
        return halfSequelize.getQueryInterface().showAllTables();
      }).then(function(tables) {
        const names = tables.map(function(t) {
          return typeof t === 'string' ? t : t.tableName;
        });
        expect(names).to.include('Bazes');
      });
    });
  });
});
