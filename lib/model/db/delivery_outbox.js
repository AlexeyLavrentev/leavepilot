"use strict";

module.exports = function(sequelize, DataTypes) {
  const DeliveryOutbox = sequelize.define("DeliveryOutbox", {
    deliveryType : {
      type      : DataTypes.STRING,
      allowNull : false,
    },
    eventType : {
      type      : DataTypes.STRING,
      allowNull : false,
    },
    payload : {
      type      : DataTypes.TEXT,
      allowNull : false,
    },
    companyId : {
      type      : DataTypes.INTEGER,
      allowNull : false,
    },
    userId : {
      type      : DataTypes.INTEGER,
      allowNull : true,
    },
    status : {
      type         : DataTypes.STRING,
      allowNull    : false,
      defaultValue : 'pending',
    },
    attempts : {
      type         : DataTypes.INTEGER,
      allowNull    : false,
      defaultValue : 0,
    },
    nextAttemptAt : {
      type      : DataTypes.DATE,
      allowNull : false,
    },
    lastError : {
      type      : DataTypes.STRING,
      allowNull : true,
    },
    deliveredAt : {
      type      : DataTypes.DATE,
      allowNull : true,
    },
  }, {
    underscored     : true,
    freezeTableName : true,
    tableName       : 'DeliveryOutboxes',
    timestamps      : true,
    indexes : [{
      fields : ['status', 'next_attempt_at'],
    }, {
      fields : ['status', 'delivered_at'],
    }],
  });

  return DeliveryOutbox;
};
