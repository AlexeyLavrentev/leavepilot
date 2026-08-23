
'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {

    return queryInterface.describeTable('Companies').then(function(attributes){

      if (Object.prototype.hasOwnProperty.call(attributes, 'company_wide_message')) {
        return 1;
      }

      return queryInterface.addColumn(
        'Companies',
        'company_wide_message',
        models.Company.attributes.company_wide_message
      );
    });

  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface.removeColumn('Companies', 'company_wide_message');
  }
};
