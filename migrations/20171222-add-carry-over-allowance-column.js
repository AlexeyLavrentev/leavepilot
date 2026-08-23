
'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {

    return queryInterface.describeTable('user_allowance_adjustment')
      .then(function(attributes){

        if (Object.prototype.hasOwnProperty.call(attributes, 'carried_over_allowance')) {
          return 1;
        }

        return queryInterface.addColumn(
          'user_allowance_adjustment',
          'carried_over_allowance',
          models.UserAllowanceAdjustment.attributes.carried_over_allowance
        );
      });
  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface
      .removeColumn('user_allowance_adjustment', 'carried_over_allowance');
  }
};
