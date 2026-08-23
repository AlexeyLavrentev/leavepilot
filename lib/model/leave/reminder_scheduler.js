"use strict";

/**
 * Reminder Scheduler
 *
 * Manages flexible reminder schedules with:
 * - Multiple reminder timing (T-14, T-7, T-3, etc.)
 * - Per-leave-type schedules
 * - Custom email templates
 */


const { Op } = require('sequelize');
const dayjs = require('../../util/date');

const NOTIFICATION_TYPE_SUPERVISOR = 'leave_start_reminder_supervisor';
const NOTIFICATION_TYPE_EMPLOYEE = 'leave_start_reminder_employee';

const approvedLeaveStatuses = models => ([
  models.Leave.status_approved(),
  models.Leave.status_pended_revoke(),
]);

/**
 * Get active reminder schedules for company
 */
const getActiveSchedules = async ({models, companyId}) => {
  return models.ReminderSchedule.findAll({
    where: {
      company_id: companyId,
      is_active: true,
    },
    order: [
      ['days_before', 'DESC'],
    ],
    include: [
      {
        model: models.LeaveType,
        as: 'leave_type',
        required: false,
      },
    ],
  });
};

/**
 * Filter schedules by leave type
 */
const getApplicableSchedules = ({schedules, leave}) => {
  return schedules.filter(schedule => {
    // If leave_type_id is null, applies to all types
    if (!schedule.leave_type_id) {
      return true;
    }

    // Otherwise, check if leave matches
    return schedule.leave_type_id === leave.leave_type_id;
  });
};

/**
 * Get reminder recipients for leave
 */
const getReminderRecipients = ({leave, schedule}) => {
  const recipients = [];
  const employee = leave.user;
  const department = employee && employee.department;
  const supervisor = department && department.boss;

  const isActiveRecipient = recipient => (
    recipient
    && recipient.email
    && (typeof recipient.is_active !== 'function' || recipient.is_active())
  );

  if (!employee || !department) {
    return recipients;
  }

  // Add supervisor if configured
  if (schedule.recipient_supervisor && isActiveRecipient(supervisor)) {
    recipients.push({
      recipient: supervisor,
      employee: employee,
      department: department,
      notification_type: NOTIFICATION_TYPE_SUPERVISOR,
      schedule: schedule,
    });
  }

  // Add employee if configured
  if (schedule.recipient_employee && isActiveRecipient(employee)) {
    recipients.push({
      recipient: employee,
      employee: employee,
      department: department,
      notification_type: NOTIFICATION_TYPE_EMPLOYEE,
      schedule: schedule,
    });
  }

  return recipients;
};

/**
 * Reserve notification (prevent duplicates)
 */
const reserveNotification = async ({models, leave, recipient, notificationType, _schedule}) => {
  const leaveStartDate = dayjs.utc(leave.date_start).format('YYYY-MM-DD');

  const result = await models.LeaveNotification.findOrCreate({
    where: {
      notification_type: notificationType,
      leave_id: leave.id,
      recipient_user_id: recipient.id,
      leave_start_date: leaveStartDate,
    },
    defaults: {
      notification_type: notificationType,
      leave_id: leave.id,
      recipient_user_id: recipient.id,
      company_id: leave.user.companyId,
      leave_start_date: leaveStartDate,
    },
  });

  return {
    notificationRecord: result[0],
    isNew: result[1],
  };
};

/**
 * Send reminder email
 */
const sendReminderEmail = async ({leave, recipientInfo, emailTransport}) => {
  const {recipient, employee, department, notification_type, schedule} = recipientInfo;

  // Use custom templates if available, otherwise use defaults
  const templateData = {
    leave,
    recipient,
    employee,
    department,
    notification_type,
    daysBefore: schedule.days_before,
    customSubject: schedule.email_subject_custom,
    customBody: schedule.email_body_custom,
  };

  await emailTransport.promise_upcoming_leave_start_reminder_email(templateData);
};

/**
 * Process leave for reminders
 */
const processLeaveForReminders = async ({leave, schedules, models, emailTransport, sentNotifications}) => {
  const applicableSchedules = getApplicableSchedules({schedules, leave});

  for (const schedule of applicableSchedules) {
    const recipients = getReminderRecipients({leave, schedule});

    for (const recipientInfo of recipients) {
      let reservation;
      try {
        reservation = await reserveNotification({
          models,
          leave,
          recipient: recipientInfo.recipient,
          notificationType: recipientInfo.notification_type,
          schedule,
        });

        // Skip if already sent
        if (!reservation.isNew) {
          continue;
        }

        // Send email
        await sendReminderEmail({
          leave,
          recipientInfo,
          emailTransport,
        });

        sentNotifications.push({
          leaveId: leave.id,
          recipientUserId: recipientInfo.recipient.id,
          notificationType: recipientInfo.notification_type,
          scheduleId: schedule.id,
          daysBefore: schedule.days_before,
        });
      } catch (error) {
        // A reservation represents a successfully sent notification. Release it
        // when delivery fails so the next scheduler run can retry the email.
        if (reservation && reservation.isNew) {
          await reservation.notificationRecord.destroy();
        }
        // eslint-disable-next-line no-console
        console.error(`Failed to send reminder for leave ${leave.id}:`, error.message);
        // Continue with other reminders
      }
    }
  }
};

/**
 * Get leaves that need reminders for specific date
 */
const getLeavesNeedingReminders = async ({models, company, targetDate}) => {
  const targetDateStart = dayjs.utc(targetDate, 'YYYY-MM-DD');
  const targetDateEnd = targetDateStart.clone().add(1, 'day').format('YYYY-MM-DD');

  return models.Leave.findAll({
    where: {
      status: {[Op.in]: approvedLeaveStatuses(models)},
      date_start: {
        [Op.gte]: targetDateStart.format('YYYY-MM-DD'),
        [Op.lt]: targetDateEnd,
      },
    },
    include: [
      {
        model: models.User,
        as: 'user',
        required: true,
        where: Object.assign(
          {companyId: company.id},
          models.User.get_active_user_filter(company.get_today())
        ),
        include: [
          {
            model: models.Company,
            as: 'company',
            required: true,
          },
          {
            model: models.Department,
            as: 'department',
            required: false,
            include: [
              {
                model: models.User,
                as: 'boss',
                required: false,
              },
            ],
          },
        ],
      },
      {
        model: models.LeaveType,
        as: 'leave_type',
        required: true,
      },
    ],
  });
};

/**
 * Send reminders for company on specific date
 */
const sendRemindersForCompany = async ({company, models, emailTransport, date}) => {
  const activeSchedules = await getActiveSchedules({models, companyId: company.id});

  // No schedules configured
  if (activeSchedules.length === 0) {
    return [];
  }

  const sentNotifications = [];

  // Process each unique days_before value
  const uniqueDaysBefore = [...new Set(activeSchedules.map(s => s.days_before))];

  for (const daysBefore of uniqueDaysBefore) {
    const targetDate = dayjs.utc(date).add(daysBefore, 'days').format('YYYY-MM-DD');
    const leaves = await getLeavesNeedingReminders({models, company, targetDate: targetDate});

    for (const leave of leaves) {
      const applicableSchedules = activeSchedules.filter(s => s.days_before === daysBefore);
      await processLeaveForReminders({
        leave,
        schedules: applicableSchedules,
        models,
        emailTransport,
        sentNotifications,
      });
    }
  }

  return sentNotifications;
};

/**
 * Send reminders for all companies (scheduler job)
 */
const sendLeaveStartReminders = async ({models, emailTransport, date, companyId}) => {
  const effectiveDate = date || dayjs.utc().format('YYYY-MM-DD');

  let companies;

  if (companyId) {
    companies = await models.Company.findAll({where: {id: companyId}});
  } else {
    companies = await models.Company.findAll();
  }

  let allNotifications = [];

  for (const company of companies) {
    const companyNotifications = await sendRemindersForCompany({
      company,
      models,
      emailTransport,
      date: effectiveDate,
    });

    allNotifications = allNotifications.concat(companyNotifications);
  }

  return allNotifications;
};

/**
 * Get reminder summary for UI
 */
const getReminderSummary = async ({models, companyId, startDate, endDate}) => {
  const where = {company_id: companyId};

  if (startDate || endDate) {
    where.created_at = {};
    if (startDate) {
      where.created_at[Op.gte] = dayjs.utc(startDate).startOf('day').toDate();
    }
    if (endDate) {
      where.created_at[Op.lte] = dayjs.utc(endDate).endOf('day').toDate();
    }
  }

  const notifications = await models.LeaveNotification.findAll({
    where,
    include: [
      {
        model: models.Leave,
        as: 'leave',
        include: [
          {model: models.User, as: 'user'},
          {model: models.LeaveType, as: 'leave_type'},
        ],
      },
      {
        model: models.User,
        as: 'recipient',
      },
    ],
    order: [['created_at', 'DESC']],
    limit: 100,
  });

  return notifications.map(n => ({
    id: n.id,
    sentAt: n.created_at,
    notificationType: n.notification_type,
    recipient: {
      id: n.recipient.id,
      name: n.recipient.full_name,
      email: n.recipient.email,
    },
    leave: {
      id: n.leave.id,
      startDate: n.leave.date_start,
      endDate: n.leave.date_end,
      user: {
        name: n.leave.user.full_name,
      },
      leaveType: {
        name: n.leave.leave_type.name,
      },
    },
  }));
};

module.exports = {
  getActiveSchedules,
  getApplicableSchedules,
  getReminderRecipients,
  getReminderSummary,
  sendLeaveStartReminders,
  sendRemindersForCompany,
  NOTIFICATION_TYPE_EMPLOYEE,
  NOTIFICATION_TYPE_SUPERVISOR,
};
