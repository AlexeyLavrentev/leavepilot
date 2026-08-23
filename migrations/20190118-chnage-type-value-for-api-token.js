
'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {
    if (queryInterface.sequelize.getDialect() !== 'sqlite') {
      return Promise.resolve();
    }

    // Guard (plan 05-06, D-02 triage): this rebuild existed to retype the
    // token column to the UUID type the model carried in 2019. The current
    // model keeps integration_api_token as a plain nullable STRING (storage
    // moved to integration_api_token_hash in 20260707100000), so there is
    // nothing to convert any more. Worse, the backup table is created from
    // the CURRENT model attributes, whose NOT NULL integration_api_token_hash
    // (function default, no SQL default) is not part of this 2019 copy list -
    // rebuilding against today's model fails on the first company row with
    // "NOT NULL constraint failed: Companies_backup.integration_api_token_hash".
    // When the current model no longer asks for UUID the migration stands
    // down instead of rewriting rows it cannot copy honestly.
    const currentType = models.Company.attributes.integration_api_token.type;
    if (!currentType || currentType.key !== 'UUID') {
      return Promise.resolve();
    }

    return queryInterface.describeTable('Companies').then(attributes => {

      if (attributes.integration_api_token.type === 'UUID') {
        return 1;
      }

      return queryInterface
        // Create Temp Compaies based on current model definitiom
        .createTable('Companies_backup', models.Company.attributes)
        .then(() => queryInterface.sequelize.query('PRAGMA foreign_keys=off;'))
        .then(() => queryInterface.sequelize.query(
          'INSERT INTO `Companies_backup` (`id`,`name`,`country`,`start_of_new_year`,`createdAt`,`updatedAt`,share_all_absences,ldap_auth_enabled,ldap_auth_config,`date_format`,`company_wide_message`,`mode`,`timezone`,`integration_api_token`,`integration_api_enabled`,`carry_over`) SELECT `id`,`name`,`country`,`start_of_new_year`,`createdAt`,`updatedAt`,share_all_absences,ldap_auth_enabled,ldap_auth_config,`date_format`,`company_wide_message`,`mode`,`timezone`,`integration_api_token`,`integration_api_enabled`,`carry_over` FROM `'+models.Company.tableName+'`'))
        .then(() => queryInterface.dropTable( models.Company.tableName ))
        .then(() => queryInterface.renameTable('Companies_backup', models.Company.tableName))
        .then(() => queryInterface.sequelize.query('PRAGMA foreign_keys=on;'))
        .then(() => queryInterface.addIndex(models.Company.tableName, ['id']));
    });
  },

  down: function (_queryInterface, _Sequelize) {
    // No way back!
    return Promise.resolve();
  }
};
