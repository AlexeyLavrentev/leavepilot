'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {
    return queryInterface.describeTable('Groups')
      .then(function(attributes){
        if (!Object.prototype.hasOwnProperty.call(attributes, 'is_hr_group')) {
          return queryInterface.addColumn(
            'Groups',
            'is_hr_group',
            models.Group.attributes.is_hr_group
          );
        }
        return 1;
      });
  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface.removeColumn('Groups', 'is_hr_group');
  }
};
