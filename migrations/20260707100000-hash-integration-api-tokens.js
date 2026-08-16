'use strict';

const tokenSecurity = require('../lib/auth/integration_api_token');

module.exports = {
  up: async function(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable('Companies');

    if (!columns.integration_api_token_hash) {
      await queryInterface.addColumn('Companies', 'integration_api_token_hash', {
        type: Sequelize.STRING(64),
        allowNull: true,
      });
    }

    if (columns.integration_api_token) {
      await queryInterface.changeColumn('Companies', 'integration_api_token', {
        type: Sequelize.UUID,
        allowNull: true,
      });

      const companies = await queryInterface.sequelize.query(
        'SELECT id, integration_api_token FROM '
          + queryInterface.queryGenerator.quoteTable('Companies'),
        {type: Sequelize.QueryTypes.SELECT}
      );

      for (const company of companies) {
        if (company.integration_api_token) {
          await queryInterface.bulkUpdate('Companies', {
            integration_api_token_hash: tokenSecurity.hashToken(company.integration_api_token),
            integration_api_token: null,
          }, {id: company.id});
        }
      }

      // Companies that never generated an integration token have no hash to
      // derive, and the NOT NULL constraint below aborts the upgrade on the
      // first such row (observed on SQLite as SQLITE_CONSTRAINT during the
      // changeColumn table rebuild; MySQL rejects the same ALTER in strict
      // mode). Their hash is set to the SHA-256 of a freshly generated token
      // whose value is discarded, so the column keeps its "hash of some
      // token" shape while matching no token anybody can present.
      // (Plan 05-06, D-02 triage.)
      const hashless = await queryInterface.sequelize.query(
        'SELECT id FROM '
          + queryInterface.queryGenerator.quoteTable('Companies')
          + ' WHERE integration_api_token_hash IS NULL',
        {type: Sequelize.QueryTypes.SELECT}
      );

      for (const company of hashless) {
        await queryInterface.bulkUpdate('Companies', {
          integration_api_token_hash: tokenSecurity.hashToken(tokenSecurity.generateToken()),
        }, {id: company.id});
      }

    }

    await queryInterface.changeColumn('Companies', 'integration_api_token_hash', {
      type: Sequelize.STRING(64),
      allowNull: false,
    });
  },

  down: function() {
    // Plaintext tokens cannot be reconstructed from their hashes.
    return Promise.resolve();
  },
};
