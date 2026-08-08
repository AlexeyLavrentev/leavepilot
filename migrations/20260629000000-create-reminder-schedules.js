"use strict";

/**
 * Migration: Create ReminderSchedules table
 *
 * Adds flexible reminder scheduling with:
 * - Multiple reminder timing (T-14, T-7, T-3, etc.)
 * - Per-leave-type schedules
 * - Custom email templates
 * - Flexible recipient selection
 *
 * Guarded with a table-existence check: installations that ran this
 * migration from the premium module already have the table, and the
 * file moved to core under the same name.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const normalizedTables = (tables || []).map(table =>
      typeof table === 'string' ? table : table && (table.tableName || table.name)
    );

    if (normalizedTables.indexOf('ReminderSchedules') !== -1) {
      return;
    }

    await queryInterface.createTable('ReminderSchedules', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },

      // Company association
      company_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Companies',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },

      // Leave type filter (NULL = all leave types)
      leave_type_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'LeaveTypes',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },

      // Reminder configuration
      days_before: {
        type: Sequelize.INTEGER,
        allowNull: false,
        comment: 'Days before leave start to send reminder',
      },

      // Who receives the reminder
      recipient_supervisor: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'Send to department supervisor',
      },

      recipient_employee: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Send to employee going on leave',
      },

      // Custom email templates (optional)
      email_subject_custom: {
        type: Sequelize.STRING(500),
        allowNull: true,
        comment: 'Custom email subject (overrides default)',
      },

      email_body_custom: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Custom email body (overrides default)',
      },

      // Active/inactive toggle
      is_active: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },

      // Timestamps
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },

      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    }, {
      tableName: 'ReminderSchedules',
      underscored: true,
      timestamps: true,

      /*
        An `indexes` option used to sit here. createTable does not read one:
        this migration has always created the table and no indexes, on every
        database it has ever run against. Removing it changes nothing - the
        table DDL is identical either way - and it stops the file describing a
        schema that does not exist.

        The three plain indexes are created by
        20260808130000-index-reminder-schedules. The unique one that was
        declared here is not, and was never anywhere else: the model does not
        declare it, so nothing has run with it, and as written it is partial -
        unique where is_active - which MySQL cannot express.
      */

      comment: 'Flexible reminder schedules for leave start notifications',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ReminderSchedules');
  },
};
