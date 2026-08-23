'use strict';

const log = require('../lib/middleware/request_logger');

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2');
const dayjs = require('../lib/util/date');
const sqlite3 = require('sqlite3').verbose();

const sourceSqlitePath = process.argv[2];

if (!sourceSqlitePath) {
  log.error('migrate_usage', { msg: 'Usage: node bin/migrate_sqlite_to_mysql.js /path/to/source.sqlite' });
  process.exit(1);
}

const resolvedSourcePath = path.resolve(sourceSqlitePath);

if (!fs.existsSync(resolvedSourcePath)) {
  log.error('sqlite_not_found', { path: resolvedSourcePath });
  process.exit(1);
}

const mysqlConfig = {
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
  log.error('mysql_not_configured', { msg: 'Target MySQL database is not configured. Set DB_NAME or MYSQL_DATABASE.' });
  process.exit(1);
}

const SQLITE_TABLES_TO_SKIP = {
  SequelizeMeta: true,
  sqlite_sequence: true,
  Sessions: true,
  Session: true,
};

function mysqlQuery(connection, sql, params) {
  return new Promise(function(resolve, reject) {
    connection.query(sql, params || [], function(error, results) {
      if (error) {
        reject(error);
        return;
      }
      resolve(results);
    });
  });
}

function sqliteAll(db, sql, params) {
  return new Promise(function(resolve, reject) {
    db.all(sql, params || [], function(error, rows) {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows);
    });
  });
}

function sqliteClose(db) {
  return new Promise(function(resolve, reject) {
    db.close(function(error) {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function normalizeDateValue(value, mysqlColumnType) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return null;
  }

  const normalizedType = String(mysqlColumnType || '').toLowerCase();
  const parsed = dayjs.utc(value);

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
  const rows = await sqliteAll(
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
  const rows = await mysqlQuery(mysqlConnection, 'SHOW TABLES');

  return rows.map(function(row) {
    return row[Object.keys(row)[0]];
  });
}

async function getTargetColumns(mysqlConnection, tableName) {
  const rows = await mysqlQuery(
    mysqlConnection,
    'SHOW COLUMNS FROM ' + escapeIdentifier(tableName)
  );

  return rows;
}

async function clearTargetTables(mysqlConnection, tableNames) {
  for (let i = 0; i < tableNames.length; i++) {
    const tableName = tableNames[i];
    log.info('clearing_table', { table: tableName });
    await mysqlQuery(
      mysqlConnection,
      'DELETE FROM ' + escapeIdentifier(tableName)
    );
  }
}

async function copyTable(sqliteDb, mysqlConnection, tableName) {
  const sourceRows = await sqliteAll(
    sqliteDb,
    'SELECT * FROM ' + escapeIdentifier(tableName)
  );

  if (!sourceRows.length) {
    log.info('skipping_empty_table', { table: tableName });
    return;
  }

  const targetColumns = await getTargetColumns(mysqlConnection, tableName);
  const targetColumnMap = {};

  targetColumns.forEach(function(column) {
    targetColumnMap[column.Field] = column;
  });

  const sourceColumns = Object.keys(sourceRows[0]).filter(function(columnName) {
    return Object.prototype.hasOwnProperty.call(targetColumnMap, columnName);
  });

  if (!sourceColumns.length) {
    log.info('skipping_table_no_matching_columns', { table: tableName });
    return;
  }

  const escapedColumns = sourceColumns.map(escapeIdentifier).join(', ');
  const batchSize = 200;

  log.info('copying_table', { table: tableName, rows: sourceRows.length });

  for (let offset = 0; offset < sourceRows.length; offset += batchSize) {
    const batch = sourceRows.slice(offset, offset + batchSize);
    const placeholders = batch.map(function() {
      return '(' + sourceColumns.map(function() { return '?'; }).join(', ') + ')';
    }).join(', ');
    const values = [];

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
  const sqliteDb = new sqlite3.Database(resolvedSourcePath, sqlite3.OPEN_READONLY);
  const mysqlConnection = mysql.createConnection(mysqlConfig);

  try {
    await mysqlQuery(mysqlConnection, 'SET FOREIGN_KEY_CHECKS = 0');

    const sourceTables = await getSourceTables(sqliteDb);
    const targetTables = await getTargetTables(mysqlConnection);
    const tablesToCopy = sourceTables.filter(function(tableName) {
      return targetTables.indexOf(tableName) >= 0;
    });

    if (!tablesToCopy.length) {
      throw new Error('No matching application tables found between SQLite and MySQL');
    }

    log.info('migration_start', {
      source: resolvedSourcePath,
      database: mysqlConfig.database,
      tables: tablesToCopy.join(', '),
    });

    await clearTargetTables(mysqlConnection, tablesToCopy);

    for (let i = 0; i < tablesToCopy.length; i++) {
      await copyTable(sqliteDb, mysqlConnection, tablesToCopy[i]);
    }

    await mysqlQuery(mysqlConnection, 'SET FOREIGN_KEY_CHECKS = 1');
    log.info('migration_complete');
  } catch (error) {
    try {
      await mysqlQuery(mysqlConnection, 'SET FOREIGN_KEY_CHECKS = 1');
    } catch (resetError) {
      log.error('foreign_key_check_reset_failed', { error: resetError.message });
    }

    log.error('migration_failed', { error: error && error.stack || String(error) });
    process.exitCode = 1;
  } finally {
    mysqlConnection.end();
    await sqliteClose(sqliteDb);
  }
}

main();
