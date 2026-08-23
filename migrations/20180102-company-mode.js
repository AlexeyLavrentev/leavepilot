
'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {

    return queryInterface.describeTable('Companies').then(function(attributes){

      if (Object.prototype.hasOwnProperty.call(attributes, 'mode')) {
        return 1;
      }

      return queryInterface.addColumn(
        'Companies',
        'mode',
        models.Company.attributes.mode
      );
    });

  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface.removeColumn('Companies', 'mode');
  }
};
