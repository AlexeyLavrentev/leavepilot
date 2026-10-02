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

function registerDeliveryOutbox(registry) {
  registry.registerScheduler({
    name    : 'delivery-outbox',
    start   : function(context) {
      return require('../scheduler/delivery_outbox_worker').startDeliveryOutboxWorker({
        models : context.models || (context.app && context.app.get('db_model')),
        logger : context.logger,
      });
    },
    runOnce : function(context) {
      // Operator re-drive entry (D-11): a manual sweep re-arms failed
      // records within the bounded retry policy.
      return require('../scheduler/delivery_outbox_worker').runDeliveryOutboxOnce({
        models        : context.models || (context.app && context.app.get('db_model')),
        logger        : context.logger,
        includeFailed : true,
      });
    },
  });
}

/*
  Community's own delivery executors (D-09): the worker owns retry/purge/
  observability for every type; behavior per type lives here. Rendering
  happens at DELIVERY time from the payload references (Pitfall 7) — the
  leave is reloaded with its user/approver/leave_type so email content is
  identical to the in-request path it replaces.
*/
function registerCommunityDeliveryExecutors(registry) {
  // V5/T-04-03: the stored payload is re-parsed defensively; a malformed
  // payload is a failed attempt (bounded retries), never executed.
  const parsePayload = record => {
    const parsed = JSON.parse(record.payload || '{}');
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Malformed delivery payload for record ' + record.id);
    }
    return parsed;
  };

  const loadLeaveForDelivery = ({models, leaveId}) => models.Leave.findByPk(leaveId, {
    include: [
      {model: models.User, as: 'user'},
      {model: models.User, as: 'approver'},
      {model: models.LeaveType, as: 'leave_type'},
    ],
  });

  registry.registerDeliveryExecutor({
    deliveryType : 'email',

    deliver: async ({record, models}) => {
      // Lazy like the scheduler registrations above: requiring the email
      // facade at registration time pulls its handlebars/helpers chain into
      // edition bootstrap and can close a require cycle mid-load.
      const EmailTransport = require('../email');

      const payload = parsePayload(record);
      const leave = await loadLeaveForDelivery({models, leaveId: payload.leaveId});

      if (!leave) {
        throw new Error('Leave not found for delivery: ' + payload.leaveId);
      }

      const email = new EmailTransport();

      switch (record.eventType) {
        case 'submitted':
          return email.promise_leave_request_emails({leave});
        case 'approve':
        case 'reject':
          return email.promise_leave_request_decision_emails({
            leave,
            action         : record.eventType,
            wasPendedRevoke: !!payload.wasPendedRevoke,
          });
        case 'cancel':
          return email.promise_leave_request_cancel_emails({leave});
        case 'revoke':
          return email.promise_leave_request_revoke_emails({leave});
        default:
          throw new Error('Unknown delivery event type: ' + record.eventType);
      }
    },
  });

  registry.registerDeliveryExecutor({
    deliveryType : 'edition_event',

    deliver: async ({record, models}) => {
      const payload = parsePayload(record);
      const leave = await loadLeaveForDelivery({models, leaveId: payload.leaveId});

      if (!leave) {
        throw new Error('Leave not found for delivery: ' + payload.leaveId);
      }

      // The dispatcher is awaited DIRECTLY (not through the fire-and-forget
      // facade wrapper, which swallows dispatcher rejections into a log
      // line): a rejected dispatch must count as a failed attempt so the
      // bounded retry policy applies to edition events too (D-03/D-10).
      const dispatcher = registry.getLeaveEventDispatcher();

      if (!dispatcher) {
        return;
      }

      await dispatcher.dispatch({type: record.eventType, leave});
    },
  });
}

function register({registry}) {
  registerPremiumNavigation(registry);
  registerLeaveStartReminders(registry);
  registerDeliveryOutbox(registry);
  registerCommunityDeliveryExecutors(registry);
  registry.registerSsoProvider(ssoStub);
  registry.registerMultipartRoute({method: 'POST', path: '/users/import/'});

  return {
    name: 'community',
  };
}

module.exports = {
  register,
};
