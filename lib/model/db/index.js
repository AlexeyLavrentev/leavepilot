"use strict";

const fs        = require("fs");
const path      = require("path");
const Sequelize = require("sequelize");
const edition   = require("../../edition");
const env       = process.env.NODE_ENV || "development";
const baseConfig = require(__dirname + '/../../../config/db.json')[env] || {};
const config = Object.assign({}, baseConfig);

if (process.env.DB_DIALECT) {
  config.dialect = process.env.DB_DIALECT;
}
if (process.env.DB_HOST) {
  config.host = process.env.DB_HOST;
}
if (process.env.DB_PORT) {
  config.port = process.env.DB_PORT;
}
if (process.env.DB_STORAGE) {
  config.storage = process.env.DB_STORAGE;
}
if (process.env.DB_LOGGING) {
  config.logging = process.env.DB_LOGGING === 'true';
}

const database = process.env.DB_NAME || process.env.MYSQL_DATABASE || config.database;
const username = process.env.DB_USER || process.env.MYSQL_USER || config.username;
const password = Object.prototype.hasOwnProperty.call(process.env, 'DB_PASSWORD')
  ? process.env.DB_PASSWORD
  : (Object.prototype.hasOwnProperty.call(process.env, 'MYSQL_PASSWORD')
    ? process.env.MYSQL_PASSWORD
    : config.password);

config.database = database;
config.username = username;
config.password = password;

// Production safety: refuse to start with dangerous defaults.
// If the operator forgot to set DB_USER / DB_PASSWORD, the fallback
// values from config/db.json ("root" / null) would silently connect
// with maximum privileges.  Fail loudly instead.
if (env === 'production') {
  if (!process.env.DB_USER && !process.env.MYSQL_USER && username === 'root') {
    throw new Error(
      'Refusing to start in production with DB user "root". '
      + 'Set DB_USER (or MYSQL_USER) to a non-root database user.'
    );
  }
  if (
    !Object.prototype.hasOwnProperty.call(process.env, 'DB_PASSWORD')
    && !Object.prototype.hasOwnProperty.call(process.env, 'MYSQL_PASSWORD')
    && (password === null || password === undefined || password === '')
  ) {
    throw new Error(
      'Refusing to start in production with an empty DB password. '
      + 'Set DB_PASSWORD (or MYSQL_PASSWORD) explicitly.'
    );
  }
}

const sequelize = new Sequelize(database, username, password, config);
const db        = {};

function loadModelsFrom(modelDir) {
  fs
  .readdirSync(modelDir)
  .filter(function(file) {
    return (file.indexOf(".") !== 0)
      && (file !== "index.js");
  })
  .forEach(function(file) {
    // sequelize 6 убрал sequelize.import — загружаем модель напрямую
    const defineModel = require(path.join(modelDir, file));
    const model = defineModel(sequelize, Sequelize.DataTypes);
    if (
      model.rawAttributes
      && (!model.attributes || Object.keys(model.attributes).length === 0)
    ) {
      model.attributes = model.rawAttributes;
    }
    db[model.name] = model;
  });
}

[__dirname].concat(edition.getDbModelPaths())
  .filter(function(modelDir, index, modelDirs) {
    return modelDir && modelDirs.indexOf(modelDir) === index && fs.existsSync(modelDir);
  })
  .forEach(loadModelsFrom);

// Link models according associations
//
Object.keys(db).forEach(function(modelName) {
  if ("associate" in db[modelName]) {
    db[modelName].associate(db);
  }
});

edition.applyDbAssociations(db);

// Add scopes
//
Object.keys(db).forEach(function(modelName) {
  if ('loadScope' in db[modelName]) {
    db[modelName].loadScope(db);
  }
});

// Link models based on associations that are based on scopes
//
Object.keys(db).forEach(function(modelName) {
  if ('scopeAssociate' in db[modelName]) {
    db[modelName].scopeAssociate(db);
  }
});

db.sequelize = sequelize;
db.Sequelize = Sequelize;
db.connect = function() {
  return sequelize.authenticate();
};

// Startup only inspects the schema. Migrations and Session table creation have
// separate owners; neither belongs in this readiness check.
db.assertSchemaReady = async function() {
  const queryInterface = sequelize.getQueryInterface();
  const existing = new Set((await queryInterface.showAllTables()).map(function(table) {
    return typeof table === 'string' ? table : table.tableName || table.name;
  }));
  const required = new Map();
  Object.keys(db).forEach(function(name) {
    const model = db[name];
    if (model && typeof model.getTableName === 'function') {
      const table = model.getTableName();
      const tableName = typeof table === 'string' ? table : table.tableName;
      required.set(tableName, model);
    }
  });

  for (const [tableName, model] of required) {
    if (!existing.has(tableName)) {
      const error = new Error('Required database table is missing: ' + tableName);
      error.code = 'SCHEMA_NOT_READY';
      throw error;
    }
    const columns = await queryInterface.describeTable(tableName);
    for (const [name, attribute] of Object.entries(model.rawAttributes)) {
      if (attribute.type && attribute.type.key === 'VIRTUAL') {
        continue;
      }
      const column = attribute.field || name;
      if (!Object.prototype.hasOwnProperty.call(columns, column)) {
        const error = new Error('Required database column is missing: ' + tableName + '.' + column);
        error.code = 'SCHEMA_NOT_READY';
        throw error;
      }
    }
  }

  if (!existing.has('SequelizeMeta')) {
    const error = new Error('Migration metadata table is missing');
    error.code = 'SCHEMA_NOT_READY';
    throw error;
  }
  const migrationPaths = [path.join(__dirname, '..', '..', '..', 'migrations')]
    .concat(edition.getMigrationPaths());
  const expectedMigrations = new Set(migrationPaths.flatMap(function(directory) {
    return fs.readdirSync(directory).filter(function(name) { return name.endsWith('.js'); });
  }));
  const executed = await sequelize.query('SELECT name FROM SequelizeMeta', {
    type: Sequelize.QueryTypes.SELECT,
  });
  const appliedMigrations = new Set(executed.map(function(row) { return row.name; }));
  for (const name of expectedMigrations) {
    if (!appliedMigrations.has(name)) {
      const error = new Error('Required database migration is pending: ' + name);
      error.code = 'SCHEMA_NOT_READY';
      throw error;
    }
  }
};

module.exports = db;
