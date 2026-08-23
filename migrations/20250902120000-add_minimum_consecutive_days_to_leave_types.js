'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {

    return queryInterface.describeTable('LeaveTypes').then(function(attributes){

      if (Object.prototype.hasOwnProperty.call(attributes, 'minimum_consecutive_days')) {
        return 1;
      }

      return queryInterface.addColumn(
        'LeaveTypes',
        'minimum_consecutive_days',
        models.LeaveType.attributes.minimum_consecutive_days
      );
    });

  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface.removeColumn('LeaveTypes', 'minimum_consecutive_days');
  }
};
