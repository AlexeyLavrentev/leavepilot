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

        if (normalizedTables.indexOf('DeliveryOutboxes') !== -1) {
          return null;
        }

        return queryInterface.createTable('DeliveryOutboxes', {
          id : {
            allowNull     : false,
            autoIncrement : true,
            primaryKey    : true,
            type          : Sequelize.INTEGER,
          },
          delivery_type : {
            type      : Sequelize.STRING,
            allowNull : false,
          },
          event_type : {
            type      : Sequelize.STRING,
            allowNull : false,
          },
          payload : {
            type      : Sequelize.TEXT,
            allowNull : false,
          },
          company_id : {
            type      : Sequelize.INTEGER,
            allowNull : false,
            references : {
              model : 'Companies',
              key   : 'id',
            },
            onUpdate : 'CASCADE',
            onDelete : 'CASCADE',
          },
          user_id : {
            type      : Sequelize.INTEGER,
            allowNull : true,
          },
          status : {
            type         : Sequelize.STRING,
            allowNull    : false,
            defaultValue : 'pending',
          },
          attempts : {
            type         : Sequelize.INTEGER,
            allowNull    : false,
            defaultValue : 0,
          },
          next_attempt_at : {
            type      : Sequelize.DATE,
            allowNull : false,
          },
          last_error : {
            type      : Sequelize.STRING,
            allowNull : true,
          },
          delivered_at : {
            type      : Sequelize.DATE,
            allowNull : true,
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
            queryInterface.addIndex('DeliveryOutboxes', [
              'status',
              'next_attempt_at',
            ], {
              name : 'delivery_outboxes_due_sweep_idx',
            }),
            queryInterface.addIndex('DeliveryOutboxes', [
              'status',
              'delivered_at',
            ], {
              name : 'delivery_outboxes_purge_idx',
            }),
          ]);
        });
      });
  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface.dropTable('DeliveryOutboxes');
  }
};
