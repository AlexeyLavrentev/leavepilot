'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {
    return queryInterface.describeTable('Groups')
      .then(function(attributes){
        if (!Object.prototype.hasOwnProperty.call(attributes, 'max_critical_overlap')) {
          return queryInterface.addColumn(
            'Groups',
            'max_critical_overlap',
            models.Group.attributes.max_critical_overlap
          );
        }
        return 1;
      });
  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface.removeColumn('Groups', 'max_critical_overlap');
  },
};
