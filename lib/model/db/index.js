"use strict";

var fs        = require("fs");
var path      = require("path");
var Sequelize = require("sequelize");
var edition   = require("../../edition");
var env       = process.env.NODE_ENV || "development";
var baseConfig = require(__dirname + '/../../../config/db.json')[env] || {};
var config = Object.assign({}, baseConfig);

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

var database = process.env.DB_NAME || process.env.MYSQL_DATABASE || config.database;
var username = process.env.DB_USER || process.env.MYSQL_USER || config.username;
var password = Object.prototype.hasOwnProperty.call(process.env, 'DB_PASSWORD')
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
  if (
    !Object.prototype.hasOwnProperty.call(process.env, 'DB_PASSWORD')
    && !Object.prototype.hasOwnProperty.call(process.env, 'MYSQL_PASSWORD')
    && password === 'CHANGE_ME'
  ) {
    throw new Error(
      'Refusing to start in production with placeholder DB password. '
      + 'Set DB_PASSWORD (or MYSQL_PASSWORD) to a real secret.'
    );
  }
}

var sequelize = new Sequelize(database, username, password, config);
var db        = {};

function loadModelsFrom(modelDir) {
  fs
  .readdirSync(modelDir)
  .filter(function(file) {
    return (file.indexOf(".") !== 0)
      && (file !== "index.js");
  })
  .forEach(function(file) {
    // sequelize 6 убрал sequelize.import — загружаем модель напрямую
    var defineModel = require(path.join(modelDir, file));
    var model = defineModel(sequelize, Sequelize.DataTypes);
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

module.exports = db;
