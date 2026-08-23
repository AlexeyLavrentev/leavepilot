'use strict';

module.exports = {
  up: function (queryInterface, Sequelize) {
    return queryInterface.showAllTables()
      .then(function(tables) {
        const normalizedTables = (tables || []).map(function(table) {
          if (typeof table === 'string') {
            return table;
          }

          return table && (table.tableName || table.name);
        });

        if (normalizedTables.indexOf('ScheduledTaskLocks') !== -1) {
          return null;
        }

        return queryInterface.createTable('ScheduledTaskLocks', {
          id : {
            allowNull     : false,
            autoIncrement : true,
            primaryKey    : true,
            type          : Sequelize.INTEGER,
          },
          task_name : {
            type      : Sequelize.STRING,
            allowNull : false,
          },
          locked_until : {
            type      : Sequelize.DATE,
            allowNull : false,
          },
          locked_by : {
            type      : Sequelize.STRING,
            allowNull : false,
          },
          created_at : {
            allowNull : false,
            type      : Sequelize.DATE,
          },
          updated_at : {
            allowNull : false,
            type      : Sequelize.DATE,
          },
        })
        .then(function() {
          return queryInterface.addIndex('ScheduledTaskLocks', ['task_name'], {
            unique : true,
            name   : 'scheduled_task_locks_task_name_unique',
          });
        });
      });
  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface.dropTable('ScheduledTaskLocks');
  }
};
