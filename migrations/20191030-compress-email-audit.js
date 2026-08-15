
'use strict';

const
  htmlToText = require('html-to-text'),
  Promise = require('bluebird'),
  models = require('../lib/model/db');

// html-to-text 10 removed fromString(); the model layer
// (lib/model/db/email_audit.js) already uses convert(). The legacy name is
// kept as a fallback so this migration still runs against an install whose
// pinned html-to-text predates the break. (Plan 05-06, D-02 triage: the
// honest pre-state replay exposed the migration crashing with
// "htmlToText.fromString is not a function" on any database that still
// needs to execute it.)
const htmlToPlainText = htmlToText.convert || htmlToText.fromString;

module.exports = {
  up: () => {
    return models.EmailAudit.findAll()
      .then(records => Promise.map(
        records,
        rec => rec.update({body : htmlToPlainText(rec.body)}),
        {concurrency: 1}
      ))
      .then(() => console.log('Done!'));
  },

  // Do nothing
  down: () => Promise.resolve(),
};
