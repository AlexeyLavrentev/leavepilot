'use strict';

module.exports = {
  up: function(queryInterface, Sequelize) {
    return queryInterface.showAllTables()
      .then(function(tables) {
        if (tables.indexOf('WorkCalendars') !== -1) {
          return 1;
        }

        return queryInterface.createTable('WorkCalendars', {
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
      })
      .then(function() {
        return queryInterface.describeTable('Departments');
      })
      .then(function(attributes) {
        if (Object.prototype.hasOwnProperty.call(attributes, 'WorkCalendarId')) {
          return 1;
        }
        return queryInterface.addColumn('Departments', 'WorkCalendarId', {
          type: Sequelize.INTEGER,
          allowNull: true,
        });
      })
      .then(function() {
        return queryInterface.describeTable('BankHolidays');
      })
      .then(function(attributes) {
        if (Object.prototype.hasOwnProperty.call(attributes, 'workCalendarId')) {
          return 1;
        }
        return queryInterface.addColumn('BankHolidays', 'workCalendarId', {
          type: Sequelize.INTEGER,
          allowNull: true,
        });
      })
      .then(function() {
        return queryInterface.describeTable('BankHolidays');
      })
      .then(function(attributes) {
        if (Object.prototype.hasOwnProperty.call(attributes, 'day_type')) {
          return 1;
        }
        return queryInterface.addColumn('BankHolidays', 'day_type', {
          type: Sequelize.STRING,
          allowNull: false,
          defaultValue: 'non_working',
        });
      });
  },

  down: function(queryInterface) {
    return queryInterface.removeColumn('BankHolidays', 'day_type')
      .then(function() {
        return queryInterface.removeColumn('BankHolidays', 'workCalendarId');
      })
      .then(function() {
        return queryInterface.removeColumn('Departments', 'WorkCalendarId');
      })
      .then(function() {
        return queryInterface.dropTable('WorkCalendars');
      });
  },
};
