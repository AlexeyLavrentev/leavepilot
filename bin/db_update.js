'use strict';

const path = require('path');
const db = require('../lib/model/db');
const edition = require('../lib/edition');
const migrator = require('../lib/model/migrator');
const ssoSecretBackfill = require('../lib/sso_secret_backfill');

db.connect()
  .then(function() {
    const sequelize = db.sequelize;
    const migrationPaths = [path.join(__dirname, '..', 'migrations')]
      .concat(edition.getMigrationPaths())
      .filter(function(migrationsPath, index, allPaths) {
        return allPaths.indexOf(migrationsPath) === index;
      });

    return migrator.run({
      sequelize: sequelize,
      Sequelize: db.Sequelize,
      migrationPaths: migrationPaths,
    })
      .then(function(result) {
        if (result.bootstrapped) {
          // eslint-disable-next-line no-console
          console.log(
            'Fresh database: created base schema and baselined migrations:',
            result.baselined.join(', ') || 'none'
          );
        } else {
          // eslint-disable-next-line no-console
          console.log('Applied migrations:', result.applied.join(', ') || 'none');
        }
        return ssoSecretBackfill.audit({ sequelize: sequelize });
      })
      .then(function(summary) {
        process.stdout.write(ssoSecretBackfill.formatSummary('startup audit', summary) + '\n');
        if (summary.plaintext > 0 || summary.decryptionFailed > 0) {
          process.stderr.write(
            'Run `npm run sso-secret-backfill -- --dry-run` and remediate before enabling SSO.\n'
          );
        }
      })
      .finally(function() {
        return sequelize.close();
      });
  })
  .catch(function(error) {
    // eslint-disable-next-line no-console
    console.error('Failed to run DB update:', error && error.stack || String(error));
    if (error && error.parent) {
      // eslint-disable-next-line no-console
      console.error('Parent error:', error.parent && error.parent.stack || String(error.parent));
    }
    if (error && error.sql) {
      // eslint-disable-next-line no-console
      console.error('SQL:', error.sql);
    }
    if (error && error.parent && error.parent.sql) {
      // eslint-disable-next-line no-console
      console.error('Parent SQL:', error.parent.sql);
    }
    process.exit(1);
  });
