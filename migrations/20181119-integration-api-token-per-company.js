
'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: (queryInterface, _Sequelize) => {

    return Promise.all([
    queryInterface.describeTable('Companies').then(attributes => {

      if (Object.prototype.hasOwnProperty.call(attributes, 'integration_api_token')) {
        return 1;
      }

      return queryInterface.addColumn(
        'Companies',
        'integration_api_token',
        models.Company.attributes.integration_api_token
      );
    }),

    queryInterface.describeTable('Companies').then(attributes => {

      if (Object.prototype.hasOwnProperty.call(attributes, 'integration_api_enabled')) {
        return 1;
      }

      return queryInterface.addColumn(
        'Companies',
        'integration_api_enabled',
        models.Company.attributes.integration_api_enabled
      );
    })
    ]);

  },

  down: (queryInterface, _Sequelize) => queryInterface
    .removeColumn('Companies', 'integration_api_token')
    .then(() => queryInterface.removeColumn('Companies', 'integration_api_enabled')),
};
