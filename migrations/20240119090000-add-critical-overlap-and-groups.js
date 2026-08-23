'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, Sequelize) {
    return queryInterface.describeTable('Departments')
      .then(function(attributes){
        if (!Object.prototype.hasOwnProperty.call(attributes, 'max_critical_overlap')) {
          return queryInterface.addColumn(
            'Departments',
            'max_critical_overlap',
            models.Department.attributes.max_critical_overlap
          );
        }
        return 1;
      })
      .then(function(){
        return queryInterface.describeTable('Users');
      })
      .then(function(attributes){
        if (!Object.prototype.hasOwnProperty.call(attributes, 'is_critical')) {
          return queryInterface.addColumn(
            'Users',
            'is_critical',
            models.User.attributes.is_critical
          );
        }
        return 1;
      })
      .then(function(){
        return queryInterface.showAllTables();
      })
      .then(function(tables){
        if (tables.indexOf('Groups') === -1) {
          return queryInterface.createTable('Groups', {
            id: {
              type: Sequelize.INTEGER,
              primaryKey: true,
              autoIncrement: true,
            },
            name: {
              type: Sequelize.STRING,
              allowNull: false,
            },
            companyId: {
              type: Sequelize.INTEGER,
              allowNull: false,
            },
            createdAt: {
              type: Sequelize.DATE,
              allowNull: false,
            },
            updatedAt: {
              type: Sequelize.DATE,
              allowNull: false,
            },
          });
        }
        return 1;
      })
      .then(function(){
        return queryInterface.showAllTables();
      })
      .then(function(tables){
        if (tables.indexOf('UserGroups') === -1) {
          return queryInterface.createTable('UserGroups', {
            id: {
              type: Sequelize.INTEGER,
              primaryKey: true,
              autoIncrement: true,
            },
            userId: {
              type: Sequelize.INTEGER,
              allowNull: false,
            },
            groupId: {
              type: Sequelize.INTEGER,
              allowNull: false,
            },
            createdAt: {
              type: Sequelize.DATE,
              allowNull: false,
            },
            updatedAt: {
              type: Sequelize.DATE,
              allowNull: false,
            },
          });
        }
        return 1;
      });
  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface.removeColumn('Departments', 'max_critical_overlap')
      .then(function(){
        return queryInterface.removeColumn('Users', 'is_critical');
      })
      .then(function(){
        return queryInterface.dropTable('UserGroups');
      })
      .then(function(){
        return queryInterface.dropTable('Groups');
      });
  }
};
