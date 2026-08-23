'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {
    return queryInterface.describeTable('UserGroups')
      .then(function(attributes){
        if (!Object.prototype.hasOwnProperty.call(attributes, 'is_critical')) {
          return queryInterface.addColumn(
            'UserGroups',
            'is_critical',
            models.UserGroup.attributes.is_critical
          );
        }
        return 1;
      });
  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface.removeColumn('UserGroups', 'is_critical');
  },
};
