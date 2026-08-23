"use strict";

module.exports = function(sequelize, DataTypes) {
  const LeaveNotification = sequelize.define("LeaveNotification", {
    notification_type : {
      type      : DataTypes.STRING,
      allowNull : false,
    },
    leave_id : {
      type      : DataTypes.INTEGER,
      allowNull : false,
    },
    recipient_user_id : {
      type      : DataTypes.INTEGER,
      allowNull : false,
    },
    company_id : {
      type      : DataTypes.INTEGER,
      allowNull : false,
    },
    leave_start_date : {
      type      : DataTypes.DATEONLY,
      allowNull : false,
    },
  }, {
    underscored     : true,
    freezeTableName : true,
    tableName       : 'LeaveNotifications',
    timestamps      : true,
    indexes : [{
      name   : 'leave_notifications_unique_reminder',
      unique : true,
      fields : ['notification_type', 'leave_id', 'recipient_user_id', 'leave_start_date'],
    }, {
      name   : 'leave_notifications_company_created_at',
      fields : ['company_id', 'created_at'],
    }],

  });

  LeaveNotification.associate = function(models) {
        LeaveNotification.belongsTo(models.Company, {
          as         : 'company',
          foreignKey : 'company_id',
        });

        LeaveNotification.belongsTo(models.User, {
          as         : 'recipient',
          foreignKey : 'recipient_user_id',
        });

        LeaveNotification.belongsTo(models.Leave, {
          as         : 'leave',
          foreignKey : 'leave_id',
        });
      };

return LeaveNotification;
};
