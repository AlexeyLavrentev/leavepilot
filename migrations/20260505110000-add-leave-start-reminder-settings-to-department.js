'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {
    return queryInterface.describeTable('Departments')
      .then(function(attributes){
        const tasks = [];

        if (!Object.prototype.hasOwnProperty.call(attributes, 'notify_leave_start_reminder')) {
          tasks.push(queryInterface.addColumn(
            'Departments',
            'notify_leave_start_reminder',
            models.Department.attributes.notify_leave_start_reminder
          ));
        }

        if (!Object.prototype.hasOwnProperty.call(attributes, 'notify_leave_start_reminder_to_employee')) {
          tasks.push(queryInterface.addColumn(
            'Departments',
            'notify_leave_start_reminder_to_employee',
            models.Department.attributes.notify_leave_start_reminder_to_employee
          ));
        }

        return Promise.all(tasks);
      });
  },

  down: function (queryInterface, _Sequelize) {
    return Promise.all([
      queryInterface.removeColumn('Departments', 'notify_leave_start_reminder_to_employee'),
      queryInterface.removeColumn('Departments', 'notify_leave_start_reminder')
    ]);
  }
};
