
'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {

    return queryInterface.describeTable('Users').then(function(attributes){

      if (Object.prototype.hasOwnProperty.call(attributes, 'auto_approve')) {
        return 1;
      }

      return queryInterface.addColumn(
        'Users',
        'auto_approve',
        models.User.attributes.auto_approve
      );
    });

  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface.removeColumn('Users', 'auto_approve');
  }
};
