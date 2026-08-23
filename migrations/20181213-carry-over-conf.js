
'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: (queryInterface, _Sequelize) => {

    return queryInterface.describeTable('Companies').then((attributes) => {

      if (Object.prototype.hasOwnProperty.call(attributes, 'carry_over')) {
        return 1;
      }

      return queryInterface.addColumn(
        'Companies',
        'carry_over',
        models.Company.attributes.carry_over
      );
    });
  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface.removeColumn('Companies', 'carry_over');
  }
};
