
'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {

    return queryInterface.describeTable('Companies')
      .then(function(attributes){

        if (Object.prototype.hasOwnProperty.call(attributes, 'timezone')) {
          return 1;
        }

        return queryInterface.addColumn(
          'Companies',
          'timezone',
          models.Company.attributes.timezone
        );
      });
  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface
      .removeColumn('Companies', 'timezone');
  }
};
