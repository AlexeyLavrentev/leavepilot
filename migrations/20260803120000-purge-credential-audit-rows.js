'use strict';

const {NEVER_AUDITED_ATTRIBUTES} = require('../lib/model/audit');

/*
  Until the deny-list landed in lib/model/audit.js, changing or deleting an
  employee wrote the scrypt hash of their password - salt included, and for
  accounts never migrated off the legacy scheme the unsalted MD5 - into the
  audit table as oldValue and newValue. The premium integration API serves that
  table to any holder of a company's static token, so the rows are removed
  rather than redacted: nothing downstream reads them, and a redacted row still
  discloses which account had its password changed and when.
*/
module.exports = {
  up: async function(queryInterface, Sequelize) {
    const audit = queryInterface.queryGenerator.quoteTable('audit');
    const attribute = queryInterface.queryGenerator.quoteIdentifier('attribute');
    const placeholders = NEVER_AUDITED_ATTRIBUTES.map(() => '?').join(', ');

    // Counted before the delete rather than read off its result: sequelize
    // reports affected rows differently per dialect, and an operator wants the
    // size of the exposure even when the dialect reports nothing.
    const [{total}] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS total FROM ${audit} WHERE ${attribute} IN (${placeholders})`,
      {replacements: NEVER_AUDITED_ATTRIBUTES, type: Sequelize.QueryTypes.SELECT}
    );

    await queryInterface.sequelize.query(
      `DELETE FROM ${audit} WHERE ${attribute} IN (${placeholders})`,
      {replacements: NEVER_AUDITED_ATTRIBUTES}
    );

    console.log(`Purged credential rows from the audit trail: ${total}`);
  },

  down: function() {
    // Password hashes are not restorable, and restoring them would undo the
    // point of the migration.
    return Promise.resolve();
  },
};
