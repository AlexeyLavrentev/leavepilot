
'use strict';

var models = require('../lib/model/db'),
  Promise = require('bluebird');

module.exports = {
  up: function (queryInterface, Sequelize) {

    return queryInterface
      .createTable(
        models.UserAllowanceAdjustment.tableName,
        models.UserAllowanceAdjustment.attributes
      )
      .then(() => queryInterface.describeTable('Users'))
      .then(function(attributes){

        if ( ! attributes.hasOwnProperty('adjustment')) {
          return Promise.resolve();
        }

        // CURRENT_TIMESTAMP on both dialects and the model's own table
        // name (plan 05-06, D-02 triage): the original SQLite-only
        // `date() || ' ' || time()` is a syntax error on MySQL (no
        // PIPES_AS_CONCAT), and the hardcoded lowercase `users` did not
        // resolve on case-sensitive servers (lower_case_table_names=0,
        // the Linux default) where the table is `Users` - either way the
        // migration aborted mid-upgrade for any deployment that still
        // owed it. Same semantics, dialect- and case-honest names.
        let sql = 'INSERT INTO ' + models.UserAllowanceAdjustment.tableName
          + ' (year, adjustment, user_id, created_at) '
          + 'SELECT 2017 AS year, adjustment as adjustment, id as user_id, CURRENT_TIMESTAMP as created_at '
          + 'FROM ' + models.User.tableName;

        return queryInterface.sequelize.query( sql );
      })

      .then(() => Promise.resolve());

  },

  down: function (queryInterface, Sequelize) {
    // No way back!
    return Promise.resolve();
  }
};
