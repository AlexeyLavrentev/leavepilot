'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {

    return queryInterface.describeTable('LeaveTypes').then(function(attributes){

      if (Object.prototype.hasOwnProperty.call(attributes, 'deduction_unit')) {
        return 1;
      }

      return queryInterface.addColumn(
        'LeaveTypes',
        'deduction_unit',
        models.LeaveType.attributes.deduction_unit
      );
    });

  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface.removeColumn('LeaveTypes', 'deduction_unit');
  }
};
