'use strict';

const log = require('../lib/middleware/request_logger');

const argv = require('minimist')(process.argv.slice(2));

const models = require('../lib/model/db');
const features = require('../lib/features');
const edition = require('../lib/edition');

const date = argv.date || null;
const companyId = argv.company_id ? Number(argv.company_id) : null;

if (!features.isEnabled('leave_start_reminders')) {
  log.info('leave_start_reminders_disabled');
  process.exit(0);
}

models.connect()
  .then(function() {
    edition.initialize({ models: models });

    return edition.getRegistry().runSchedulerOnce('leave-start-reminders', {
      models    : models,
      date      : date,
      companyId : companyId,
    });
  })
  .then(function(notifications) {
    log.info('sent_leave_start_reminders', { count: notifications.length });
    notifications.forEach(function(notification) {
      log.info('leave_reminder_sent', {
        leaveId: notification.leaveId,
        recipientUserId: notification.recipientUserId,
        notificationType: notification.notificationType,
      });
    });
  })
  .then(function() {
    return models.sequelize.close();
  })
  .catch(function(error) {
    log.error('send_reminders_failed', {
      error: error && error.stack || String(error),
    });

    return models.sequelize.close()
      .catch(function() {})
      .then(function() {
        process.exit(1);
      });
  });
