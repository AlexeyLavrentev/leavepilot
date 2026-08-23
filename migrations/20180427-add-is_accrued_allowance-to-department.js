
'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {

    return queryInterface.describeTable('Departments')
      .then(function(attributes){

        if (Object.prototype.hasOwnProperty.call(attributes, 'is_accrued_allowance')) {
          return 1;
        }

        return queryInterface.addColumn(
          'Departments',
          'is_accrued_allowance',
          models.Department.attributes.is_accrued_allowance
        );
      });
  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface
      .removeColumn('Departments', 'is_accrued_allowance');
  }
};
