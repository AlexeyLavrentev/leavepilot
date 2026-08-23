'use strict';

const log = require('../lib/middleware/request_logger');

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, _Sequelize) {

    return queryInterface.describeTable('Departments').then(function(attributes){

      if (Object.prototype.hasOwnProperty.call(attributes, 'allowance')) {
        return 1;
      }

      if (queryInterface.sequelize.getDialect() === 'sqlite') {

        log.info('Going into SQLIite case');

        return queryInterface
          // Create Temp Departments based on current model definitiom
          .createTable('Departments_backup', models.Department.attributes)

          .then(function(){
            return queryInterface.sequelize.query('PRAGMA foreign_keys=off;');
          })

          // Copy data form original Departments into new Temp one
          .then(function(){
            return queryInterface.sequelize.query(
              'INSERT INTO `Departments_backup` (id, name, include_public_holidays, createdAt, updatedAt, companyId, bossId, allowance) SELECT id, name, include_public_holidays, createdAt, updatedAt, companyId, bossId, allowence FROM `'+ models.Department.tableName +'`');
          })

          .then(function(){
            return queryInterface.dropTable( models.Department.tableName );
          })

          .then(function(){
            return queryInterface.renameTable('Departments_backup', models.Department.tableName);
          })

          .then(function(){
            return queryInterface.sequelize.query('PRAGMA foreign_keys=on;');
          })

          .then(function(){
            return queryInterface.addIndex(models.Department.tableName, ['companyId']);
          })

          .then(function(){
            return queryInterface.addIndex(models.Department.tableName, ['id']);
          });

      }

      log.info('Generic option');

      return queryInterface.renameColumn('Departments', 'allowence', 'allowance')
        .then(function(d){ log.info(d); });
    });
  },

  down: function (queryInterface, _Sequelize) {
    return queryInterface.renameColumn('Departments', 'allowance', 'allowence');
  }
};
