
'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {

    return queryInterface.describeTable('LeaveTypes').then(function(attributes){

      if (Object.prototype.hasOwnProperty.call(attributes, 'sort_order')) {
        return 1;
      }

      return queryInterface.addColumn(
        'LeaveTypes',
        'sort_order',
        models.LeaveType.attributes.sort_order
      );
    });

  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface.removeColumn('LeaveTypes', 'sort_order');
  }
};
