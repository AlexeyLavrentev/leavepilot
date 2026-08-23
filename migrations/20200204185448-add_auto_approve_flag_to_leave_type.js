'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {

    return queryInterface.describeTable('LeaveTypes').then(function(attributes){

      if (Object.prototype.hasOwnProperty.call(attributes, 'auto_approve')) {
        return 1;
      }

      return queryInterface.addColumn(
        'LeaveTypes',
        'auto_approve',
        models.LeaveType.attributes.auto_approve
      );
    });

  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface.removeColumn('LeaveTypes', 'auto_approve');
  }
};
