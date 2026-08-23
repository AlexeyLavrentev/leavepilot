'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {
    return queryInterface.describeTable('Companies')
      .then(function(attributes){
        const tasks = [];

        if (!Object.prototype.hasOwnProperty.call(attributes, 'sso_auth_enabled')) {
          tasks.push(queryInterface.addColumn(
            'Companies',
            'sso_auth_enabled',
            models.Company.attributes.sso_auth_enabled
          ));
        }

        if (!Object.prototype.hasOwnProperty.call(attributes, 'sso_auth_provider')) {
          tasks.push(queryInterface.addColumn(
            'Companies',
            'sso_auth_provider',
            models.Company.attributes.sso_auth_provider
          ));
        }

        if (!Object.prototype.hasOwnProperty.call(attributes, 'sso_auth_config')) {
          tasks.push(queryInterface.addColumn(
            'Companies',
            'sso_auth_config',
            models.Company.attributes.sso_auth_config
          ));
        }

        return Promise.all(tasks);
      });
  },

  down: function (queryInterface, _Sequelize) {
    return Promise.all([
      queryInterface.removeColumn('Companies', 'sso_auth_config'),
      queryInterface.removeColumn('Companies', 'sso_auth_provider'),
      queryInterface.removeColumn('Companies', 'sso_auth_enabled')
    ]);
  }
};
