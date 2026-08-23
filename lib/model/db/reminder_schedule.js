"use strict";

/**
 * ReminderSchedule Model
 *
 * Represents a reminder schedule for leave notifications.
 * Supports multiple reminder timing and per-leave-type schedules.
 */

module.exports = function(sequelize, DataTypes) {
  const ReminderSchedule = sequelize.define("ReminderSchedule", {
    company_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notEmpty: true,
      },
    },

    leave_type_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'NULL means all leave types',
    },

    days_before: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        min: {
          args: [1],
          msg: 'Напоминание должно быть минимум за 1 день',
        },
        max: {
          args: [365],
          msg: 'Напоминание не может быть больше чем за 365 дней',
        },
      },
    },

    recipient_supervisor: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },

    recipient_employee: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },

    email_subject_custom: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },

    email_body_custom: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  }, {
    underscored: true,
    freezeTableName: true,
    tableName: 'ReminderSchedules',
    timestamps: true,

    indexes: [
      {
        name: 'reminder_schedules_company_active',
        fields: ['company_id', 'is_active'],
      },
      {
        name: 'reminder_schedules_leave_type',
        fields: ['leave_type_id'],
      },
      {
        name: 'reminder_schedules_days_before',
        fields: ['days_before'],
      },
    ],

    getterMethods: {
      // Check if this schedule applies to all leave types
      isUniversal: function() {
        return !this.leave_type_id;
      },

      // Get recipient types as array
      recipientTypes: function() {
        const types = [];
        if (this.recipient_supervisor) {types.push('supervisor');}
        if (this.recipient_employee) {types.push('employee');}
        return types;
      },

      // Check if has custom templates
      hasCustomTemplates: function() {
        return !!(this.email_subject_custom || this.email_body_custom);
      },
    },

    instanceMethods: {
      // Validate that at least one recipient is selected
      validateRecipients: function() {
        if (!this.recipient_supervisor && !this.recipient_employee) {
          throw new Error('Должен быть выбран хотя бы один получатель');
        }
      },

      // Get display name for UI
      getDisplayName: function() {
        const leaveType = this.leave_type_id ? this.leave_type?.name : 'Все типы';
        return `T-${this.days_before}: ${leaveType}`;
      },
    },

    classMethods: {
      // Get CIS default schedules for new company
      getCisDefaults: function(companyId) {
        return [
          {
            company_id: companyId,
            leave_type_id: null, // All types
            days_before: 14,
            recipient_supervisor: true,
            recipient_employee: true,
            is_active: true,
          },
          {
            company_id: companyId,
            leave_type_id: null, // All types
            days_before: 7,
            recipient_supervisor: true,
            recipient_employee: true,
            is_active: true,
          },
        ];
      },

      // Get active schedules for company
      getActiveForCompany: function(companyId) {
        return this.findAll({
          where: {
            company_id: companyId,
            is_active: true,
          },
          order: [
            ['days_before', 'DESC'],
          ],
          include: [
            {
              model: sequelize.models.LeaveType,
              as: 'leave_type',
              required: false,
            },
          ],
        });
      },
    },
  });

  // Sequelize 6 ignores the legacy classMethods/instanceMethods options.
  ReminderSchedule.getCisDefaults = function(companyId) {
    return [14, 7].map(daysBefore => ({
      company_id: companyId,
      leave_type_id: null,
      days_before: daysBefore,
      recipient_supervisor: true,
      recipient_employee: true,
      is_active: true,
    }));
  };
  ReminderSchedule.getActiveForCompany = function(companyId) {
    return this.findAll({
      where: {company_id: companyId, is_active: true},
      order: [['days_before', 'DESC']],
      include: [{
        model: sequelize.models.LeaveType,
        as: 'leave_type',
        required: false,
      }],
    });
  };
  ReminderSchedule.prototype.validateRecipients = function() {
    if (!this.recipient_supervisor && !this.recipient_employee) {
      throw new Error('Должен быть выбран хотя бы один получатель');
    }
  };
  ReminderSchedule.prototype.getDisplayName = function() {
    const leaveType = this.leave_type_id && this.leave_type ? this.leave_type.name : 'Все типы';
    return `T-${this.days_before}: ${leaveType}`;
  };

  ReminderSchedule.associate = function(models) {
    ReminderSchedule.belongsTo(models.Company, {
      as: 'company',
      foreignKey: 'company_id',
    });

    ReminderSchedule.belongsTo(models.LeaveType, {
      as: 'leave_type',
      foreignKey: 'leave_type_id',
    });
  };

  return ReminderSchedule;
};
