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

        if (normalizedTables.indexOf('LeaveNotifications') !== -1) {
          return null;
        }

        return queryInterface.createTable('LeaveNotifications', {
          id : {
            allowNull     : false,
            autoIncrement : true,
            primaryKey    : true,
            type          : Sequelize.INTEGER,
          },
          notification_type : {
            type      : Sequelize.STRING,
            allowNull : false,
          },
          leave_id : {
            type      : Sequelize.INTEGER,
            allowNull : false,
          },
          recipient_user_id : {
            type      : Sequelize.INTEGER,
            allowNull : false,
          },
          company_id : {
            type      : Sequelize.INTEGER,
            allowNull : false,
          },
          leave_start_date : {
            type      : Sequelize.DATEONLY,
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
          return Promise.all([
            queryInterface.addIndex('LeaveNotifications', [
              'notification_type',
              'leave_id',
              'recipient_user_id',
              'leave_start_date',
            ], {
              unique : true,
              name   : 'leave_notifications_unique_reminder',
            }),
            queryInterface.addIndex('LeaveNotifications', [
              'company_id',
              'created_at',
            ], {
              name : 'leave_notifications_company_created_at',
            }),
          ]);
        });
      });
  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface.dropTable('LeaveNotifications');
  }
};
