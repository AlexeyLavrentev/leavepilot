'use strict';

var fs = require('fs');
var path = require('path');
var mysql = require('mysql2');
var dayjs = require('../lib/util/date');
var sqlite3 = require('sqlite3').verbose();

var sourceSqlitePath = process.argv[2];

if (!sourceSqlitePath) {
  console.error('Usage: node bin/migrate_sqlite_to_mysql.js /path/to/source.sqlite');
  process.exit(1);
}

var resolvedSourcePath = path.resolve(sourceSqlitePath);

if (!fs.existsSync(resolvedSourcePath)) {
  console.error('SQLite database file does not exist: ' + resolvedSourcePath);
  process.exit(1);
}

var mysqlConfig = {
  host: process.env.DB_HOST || process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || process.env.MYSQL_USER || 'root',
  password: Object.prototype.hasOwnProperty.call(process.env, 'DB_PASSWORD')
    ? process.env.DB_PASSWORD
    : (process.env.MYSQL_PASSWORD || ''),
  database: process.env.DB_NAME || process.env.MYSQL_DATABASE,
  multipleStatements: false,
};

if (!mysqlConfig.database) {
  console.error('Target MySQL database is not configured. Set DB_NAME or MYSQL_DATABASE.');
  process.exit(1);
}

var SQLITE_TABLES_TO_SKIP = {
  SequelizeMeta: true,
  sqlite_sequence: true,
  Sessions: true,
  Session: true,
};

function mysqlQuery(connection, sql, params) {
  return new Promise(function(resolve, reject) {
    connection.query(sql, params || [], function(error, results) {
      if (error) {
        return reject(error);
      }
      resolve(results);
    });
  });
}

function sqliteAll(db, sql, params) {
  return new Promise(function(resolve, reject) {
    db.all(sql, params || [], function(error, rows) {
      if (error) {
        return reject(error);
      }
      resolve(rows);
    });
  });
}

function sqliteClose(db) {
  return new Promise(function(resolve, reject) {
    db.close(function(error) {
      if (error) {
        return reject(error);
      }
      resolve();
    });
  });
}

function normalizeDateValue(value, mysqlColumnType) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return null;
  }

  var normalizedType = String(mysqlColumnType || '').toLowerCase();
  var parsed = dayjs.utc(value);

  if (!parsed.isValid()) {
    return value;
  }

  if (normalizedType.indexOf('date') === 0 && normalizedType.indexOf('datetime') !== 0) {
    return parsed.format('YYYY-MM-DD');
  }

  if (
    normalizedType.indexOf('datetime') === 0
    || normalizedType.indexOf('timestamp') === 0
  ) {
    return parsed.format('YYYY-MM-DD HH:mm:ss');
  }

  return value;
}

function normalizeRowValue(value, mysqlColumn) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (typeof value === 'undefined') {
    return null;
  }

  if (typeof value === 'string' && mysqlColumn && mysqlColumn.Type) {
    return normalizeDateValue(value, mysqlColumn.Type);
  }

  return value;
}

function escapeIdentifier(identifier) {
  return '`' + String(identifier).replace(/`/g, '``') + '`';
}

async function getSourceTables(sqliteDb) {
  var rows = await sqliteAll(
    sqliteDb,
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  );

  return rows
    .map(function(row) {
      return row.name;
    })
    .filter(function(tableName) {
      return !SQLITE_TABLES_TO_SKIP[tableName];
    });
}

async function getTargetTables(mysqlConnection) {
  var rows = await mysqlQuery(mysqlConnection, 'SHOW TABLES');

  return rows.map(function(row) {
    return row[Object.keys(row)[0]];
  });
}

async function getTargetColumns(mysqlConnection, tableName) {
  var rows = await mysqlQuery(
    mysqlConnection,
    'SHOW COLUMNS FROM ' + escapeIdentifier(tableName)
  );

  return rows;
}

async function clearTargetTables(mysqlConnection, tableNames) {
  for (var i = 0; i < tableNames.length; i++) {
    var tableName = tableNames[i];
    console.log('Clearing target table: ' + tableName);
    await mysqlQuery(
      mysqlConnection,
      'DELETE FROM ' + escapeIdentifier(tableName)
    );
  }
}

async function copyTable(sqliteDb, mysqlConnection, tableName) {
  var sourceRows = await sqliteAll(
    sqliteDb,
    'SELECT * FROM ' + escapeIdentifier(tableName)
  );

  if (!sourceRows.length) {
    console.log('Skipping empty table: ' + tableName);
    return;
  }

  var targetColumns = await getTargetColumns(mysqlConnection, tableName);
  var targetColumnMap = {};

  targetColumns.forEach(function(column) {
    targetColumnMap[column.Field] = column;
  });

  var sourceColumns = Object.keys(sourceRows[0]).filter(function(columnName) {
    return Object.prototype.hasOwnProperty.call(targetColumnMap, columnName);
  });

  if (!sourceColumns.length) {
    console.log('Skipping table without matching target columns: ' + tableName);
    return;
  }

  var escapedColumns = sourceColumns.map(escapeIdentifier).join(', ');
  var batchSize = 200;

  console.log(
    'Copying table ' + tableName + ': ' + sourceRows.length + ' rows'
  );

  for (var offset = 0; offset < sourceRows.length; offset += batchSize) {
    var batch = sourceRows.slice(offset, offset + batchSize);
    var placeholders = batch.map(function() {
      return '(' + sourceColumns.map(function() { return '?'; }).join(', ') + ')';
    }).join(', ');
    var values = [];

    batch.forEach(function(row) {
      sourceColumns.forEach(function(columnName) {
        values.push(normalizeRowValue(row[columnName], targetColumnMap[columnName]));
      });
    });

    await mysqlQuery(
      mysqlConnection,
      'INSERT INTO ' + escapeIdentifier(tableName)
        + ' (' + escapedColumns + ') VALUES ' + placeholders,
      values
    );
  }
}

async function main() {
  var sqliteDb = new sqlite3.Database(resolvedSourcePath, sqlite3.OPEN_READONLY);
  var mysqlConnection = mysql.createConnection(mysqlConfig);

  try {
    await mysqlQuery(mysqlConnection, 'SET FOREIGN_KEY_CHECKS = 0');

    var sourceTables = await getSourceTables(sqliteDb);
    var targetTables = await getTargetTables(mysqlConnection);
    var tablesToCopy = sourceTables.filter(function(tableName) {
      return targetTables.indexOf(tableName) >= 0;
    });

    if (!tablesToCopy.length) {
      throw new Error('No matching application tables found between SQLite and MySQL');
    }

    console.log('Source SQLite: ' + resolvedSourcePath);
    console.log('Target MySQL database: ' + mysqlConfig.database);
    console.log('Tables to copy: ' + tablesToCopy.join(', '));

    await clearTargetTables(mysqlConnection, tablesToCopy);

    for (var i = 0; i < tablesToCopy.length; i++) {
      await copyTable(sqliteDb, mysqlConnection, tablesToCopy[i]);
    }

    await mysqlQuery(mysqlConnection, 'SET FOREIGN_KEY_CHECKS = 1');
    console.log('SQLite to MySQL migration finished successfully.');
  } catch (error) {
    try {
      await mysqlQuery(mysqlConnection, 'SET FOREIGN_KEY_CHECKS = 1');
    } catch (resetError) {
      console.error('Failed to restore FOREIGN_KEY_CHECKS:', resetError.message);
    }

    console.error(error && error.stack || error);
    process.exitCode = 1;
  } finally {
    mysqlConnection.end();
    await sqliteClose(sqliteDb);
  }
}

main();
