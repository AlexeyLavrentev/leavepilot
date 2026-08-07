'use strict';

const express = require('express');
const ssoStub = require('../sso');
const features = require('../features');

function registerPremiumNavigation(registry) {
  registry.registerNavigationItem({
    feature  : 'ldap_authentication',
    name     : 'auth-config',
    path     : '/settings/company/authentication/',
    labelKey : 'nav.authConfig',
    location : 'settings_company',
    icon     : 'fa-lock',
    order    : 40,
  });
}

function registerLeaveStartReminders(registry) {
  const ensureAdmin = require('../middleware/ensure_user_is_admin');

  registry.registerNavigationItem({
    feature  : 'leave_start_reminders',
    name     : 'reminder-schedules',
    path     : '/settings/reminder-schedules/',
    labelKey : 'nav.reminderSchedules',
    location : 'settings_company',
    icon     : 'fa-bell',
    order    : 49,
  });

  /*
    The path is the prefix the router serves, not '/'. Mounted at '/', the two
    middleware below become layers over every URL, so every request that got
    this far - a premium page, a mistyped address - met the admin gate and was
    answered 303 instead of reaching its own route.
  */
  const registerProtectedRouter = ({name, feature, path, configure}) => {
    const router = express.Router();
    configure(router);
    registry.registerRoute({
      name,
      path,
      middleware: [features.requireFeature(feature), ensureAdmin],
      router,
    });
  };

  const reminderSchedules = require('../route/reminder_schedules');

  registerProtectedRouter({
    name: 'reminder-schedules-settings',
    feature: 'leave_start_reminders',
    path: '/settings/reminder-schedules/',
    configure: router => reminderSchedules.registerSettings(router),
  });
  registerProtectedRouter({
    name: 'reminder-schedules-api',
    feature: 'leave_start_reminders',
    path: '/api/reminder-schedules',
    configure: router => reminderSchedules.registerApi(router),
  });

  registry.registerScheduler({
    name    : 'leave-start-reminders',
    start   : function(context) {
      return require('../scheduler/leave_start_reminders').startLeaveReminderScheduler({
        models : context.models || (context.app && context.app.get('db_model')),
        logger : context.logger,
      });
    },
    runOnce : function(context) {
      return require('../scheduler/leave_start_reminders').runLeaveRemindersOnce({
        models     : context.models || (context.app && context.app.get('db_model')),
        date       : context.date,
        daysBefore : context.daysBefore,
        companyId  : context.companyId,
      });
    },
  });
}

function register({registry}) {
  registerPremiumNavigation(registry);
  registerLeaveStartReminders(registry);
  registry.registerSsoProvider(ssoStub);
  registry.registerMultipartRoute({method: 'POST', path: '/users/import/'});

  return {
    name: 'community',
  };
}

module.exports = {
  register,
};
