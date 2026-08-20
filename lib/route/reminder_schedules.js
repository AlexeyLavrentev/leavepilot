"use strict";

/**
 * Reminder Schedules Routes
 *
 * Settings page and API endpoints for managing leave start reminder
 * schedules. Moved from the premium module: leave start reminders are
 * a Community feature.
 */

const dayjs = require('../util/date');
const features = require('../features');

const parseBoolean = value => value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
const parseDays = value => {
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : null;
};
const getCompany = req => req.user.company || req.user.getCompany();
const validateLeaveType = async (models, companyId, leaveTypeId) => {
  if (!leaveTypeId) return null;
  return models.LeaveType.findOne({where: {id: leaveTypeId, companyId}});
};

/**
 * GET /settings/reminder-schedules/
 *
 * Show reminder schedules settings page
 */
async function showReminderSchedules(req, res) {
  try {
    if (!features.isEnabled('leave_start_reminders')) {
      return res.redirect('/settings/company/');
    }

    const models = req.app.get('db_model');
    const company = req.user.company || await req.user.getCompany();

    // Get leave types for dropdown
    const leaveTypes = await models.LeaveType.findAll({
      where: {companyId: company.id},
      order: [['name', 'ASC']],
    });

    const recentLeaves = await models.Leave.findAll({
      where: {status: models.Leave.status_approved()},
      include: [
        {model: models.User, as: 'user', where: {companyId: company.id}, required: true},
        {model: models.LeaveType, as: 'leave_type'},
      ],
      order: [['date_start', 'DESC']],
      limit: 50,
    });

    // The page's own script, which used to be inline in the template.
    res.locals.custom_java_script.push('/js/reminder_schedules.js');

    res.render('reminder_schedules_settings', {
      title: req.t('nav.reminderSchedules'),
      company,
      leaveTypes,
      recentLeaves: recentLeaves.map(leave => ({
        id: leave.id,
        label: `${leave.user.full_name()} — ${leave.leave_type.name} (${dayjs.utc(leave.date_start).format('YYYY-MM-DD')} – ${dayjs.utc(leave.date_end).format('YYYY-MM-DD')})`,
      })),
      csrfToken: res.locals.csrf_token,
    });
  } catch (error) {
    console.error('Show reminder schedules error:', error);
    res.redirect('/settings/company/');
  }
}

/**
 * GET /api/reminder-schedules
 *
 * Get all reminder schedules for current company
 */
async function listSchedules(req, res) {
  try {
    if (!features.isEnabled('leave_start_reminders')) {
      return res.status(403).json({
        error: req.t('emails.reminderSchedules.errors.featureDisabled'),
      });
    }

    const models = req.app.get('db_model');
    const company = await getCompany(req);

    const schedules = await models.ReminderSchedule.findAll({
      where: {company_id: company.id},
      order: [['days_before', 'DESC']],
      include: [{model: models.LeaveType, as: 'leave_type', required: false}],
    });

    return res.json({
      schedules: schedules.map(schedule => ({
        id: schedule.id,
        companyId: schedule.company_id,
        leaveTypeId: schedule.leave_type_id,
        leaveTypeName: schedule.leave_type?.name || null,
        daysBefore: schedule.days_before,
        recipientSupervisor: schedule.recipient_supervisor,
        recipientEmployee: schedule.recipient_employee,
        hasCustomTemplates: !!(schedule.email_subject_custom || schedule.email_body_custom),
        emailSubjectCustom: schedule.email_subject_custom,
        emailBodyCustom: schedule.email_body_custom,
        isActive: schedule.is_active,
        createdAt: schedule.created_at,
        updatedAt: schedule.updated_at,
      })),
    });
  } catch (error) {
    console.error('List reminder schedules error:', error);
    return res.status(500).json({
      error: req.t('emails.reminderSchedules.errors.listFailed'),
    });
  }
}

/**
 * POST /api/reminder-schedules
 *
 * Create new reminder schedule
 */
async function createSchedule(req, res) {
  try {
    if (!features.isEnabled('leave_start_reminders')) {
      return res.status(403).json({
        error: req.t('emails.reminderSchedules.errors.featureDisabled'),
      });
    }

    const models = req.app.get('db_model');
    const company = await getCompany(req);

    const {
      leaveTypeId,
      daysBefore,
      recipientSupervisor,
      recipientEmployee,
      emailSubjectCustom,
      emailBodyCustom,
    } = req.body;

    // Validate
    const parsedDays = parseDays(daysBefore);
    if (!parsedDays) {
      return res.status(400).json({
        error: req.t('emails.reminderSchedules.errors.daysBeforeRange'),
      });
    }

    const sendSupervisor = parseBoolean(recipientSupervisor);
    const sendEmployee = parseBoolean(recipientEmployee);
    if (!sendSupervisor && !sendEmployee) {
      return res.status(400).json({
        error: req.t('emails.reminderSchedules.errors.recipientRequired'),
      });
    }

    // Create schedule
    if (leaveTypeId && !await validateLeaveType(models, company.id, leaveTypeId)) {
      return res.status(400).json({error: req.t('emails.reminderSchedules.errors.invalidLeaveType')});
    }

    const existing = await models.ReminderSchedule.findOne({
      where: {company_id: company.id, leave_type_id: leaveTypeId || null, days_before: parsedDays},
    });
    if (existing) return res.status(400).json({error: req.t('emails.reminderSchedules.errors.duplicateSchedule')});

    const schedule = await models.ReminderSchedule.create({
      company_id: company.id,
      leave_type_id: leaveTypeId || null,
      days_before: parsedDays,
      recipient_supervisor: sendSupervisor,
      recipient_employee: sendEmployee,
      email_subject_custom: emailSubjectCustom || null,
      email_body_custom: emailBodyCustom || null,
      is_active: true,
    });

    return res.status(201).json({
      schedule: {
        id: schedule.id,
        companyId: schedule.company_id,
        leaveTypeId: schedule.leave_type_id,
        daysBefore: schedule.days_before,
        recipientSupervisor: schedule.recipient_supervisor,
        recipientEmployee: schedule.recipient_employee,
        hasCustomTemplates: !!(schedule.email_subject_custom || schedule.email_body_custom),
        isActive: schedule.is_active,
      },
    });
  } catch (error) {
    console.error('Create reminder schedule error:', error);

    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({
        error: req.t('emails.reminderSchedules.errors.duplicateSchedule'),
      });
    }

    return res.status(500).json({
      error: req.t('emails.reminderSchedules.errors.createFailed'),
    });
  }
}

/**
 * PUT /api/reminder-schedules/:id
 *
 * Update existing reminder schedule
 */
async function updateSchedule(req, res) {
  try {
    if (!features.isEnabled('leave_start_reminders')) {
      return res.status(403).json({
        error: req.t('emails.reminderSchedules.errors.featureDisabled'),
      });
    }

    const models = req.app.get('db_model');
    const company = await getCompany(req);
    const scheduleId = parseInt(req.params.id, 10);

    const schedule = await models.ReminderSchedule.findOne({
      where: {
        id: scheduleId,
        company_id: company.id,
      },
    });

    if (!schedule) {
      return res.status(404).json({
        error: req.t('emails.reminderSchedules.errors.scheduleNotFound'),
      });
    }

    const {
      leaveTypeId,
      daysBefore,
      recipientSupervisor,
      recipientEmployee,
      emailSubjectCustom,
      emailBodyCustom,
      isActive,
    } = req.body;

    // Validate if provided
    const parsedDays = daysBefore === undefined ? undefined : parseDays(daysBefore);
    if (daysBefore !== undefined && !parsedDays) {
      return res.status(400).json({
        error: req.t('emails.reminderSchedules.errors.daysBeforeRange'),
      });
    }

    const nextSupervisor = recipientSupervisor === undefined
      ? schedule.recipient_supervisor
      : parseBoolean(recipientSupervisor);
    const nextEmployee = recipientEmployee === undefined
      ? schedule.recipient_employee
      : parseBoolean(recipientEmployee);
    if (!nextSupervisor && !nextEmployee) {
        return res.status(400).json({
          error: req.t('emails.reminderSchedules.errors.recipientRequired'),
        });
    }

    if (leaveTypeId !== undefined && leaveTypeId && !await validateLeaveType(models, company.id, leaveTypeId)) {
      return res.status(400).json({error: req.t('emails.reminderSchedules.errors.invalidLeaveType')});
    }

    const nextLeaveTypeId = leaveTypeId === undefined ? schedule.leave_type_id : leaveTypeId || null;
    const nextDaysBefore = parsedDays === undefined ? schedule.days_before : parsedDays;
    const duplicate = await models.ReminderSchedule.findOne({
      where: {
        id: {[models.Sequelize.Op.ne]: schedule.id},
        company_id: company.id,
        leave_type_id: nextLeaveTypeId,
        days_before: nextDaysBefore,
      },
    });
    if (duplicate) return res.status(400).json({error: req.t('emails.reminderSchedules.errors.duplicateSchedule')});

    // Update
    const updateData = {};

    if (leaveTypeId !== undefined) updateData.leave_type_id = leaveTypeId || null;
    if (daysBefore !== undefined) updateData.days_before = parsedDays;
    if (recipientSupervisor !== undefined) updateData.recipient_supervisor = nextSupervisor;
    if (recipientEmployee !== undefined) updateData.recipient_employee = nextEmployee;
    if (emailSubjectCustom !== undefined) updateData.email_subject_custom = emailSubjectCustom || null;
    if (emailBodyCustom !== undefined) updateData.email_body_custom = emailBodyCustom || null;
    if (isActive !== undefined) updateData.is_active = parseBoolean(isActive);

    await schedule.update(updateData);

    return res.json({
      schedule: {
        id: schedule.id,
        companyId: schedule.company_id,
        leaveTypeId: schedule.leave_type_id,
        daysBefore: schedule.days_before,
        recipientSupervisor: schedule.recipient_supervisor,
        recipientEmployee: schedule.recipient_employee,
        hasCustomTemplates: !!(schedule.email_subject_custom || schedule.email_body_custom),
        isActive: schedule.is_active,
      },
    });
  } catch (error) {
    console.error('Update reminder schedule error:', error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({error: req.t('emails.reminderSchedules.errors.duplicateSchedule')});
    }
    return res.status(500).json({
      error: req.t('emails.reminderSchedules.errors.updateFailed'),
    });
  }
}

/**
 * DELETE /api/reminder-schedules/:id
 *
 * Delete reminder schedule
 */
async function deleteSchedule(req, res) {
  try {
    if (!features.isEnabled('leave_start_reminders')) {
      return res.status(403).json({
        error: req.t('emails.reminderSchedules.errors.featureDisabled'),
      });
    }

    const models = req.app.get('db_model');
    const company = await getCompany(req);
    const scheduleId = parseInt(req.params.id, 10);

    const schedule = await models.ReminderSchedule.findOne({
      where: {
        id: scheduleId,
        company_id: company.id,
      },
    });

    if (!schedule) {
      return res.status(404).json({
        error: req.t('emails.reminderSchedules.errors.scheduleNotFound'),
      });
    }

    await schedule.destroy();

    return res.status(204).send();
  } catch (error) {
    console.error('Delete reminder schedule error:', error);
    return res.status(500).json({
      error: req.t('emails.reminderSchedules.errors.deleteFailed'),
    });
  }
}

/**
 * GET /api/reminder-schedules/history
 *
 * Get reminder history for company
 */
async function getHistory(req, res) {
  try {
    if (!features.isEnabled('leave_start_reminders')) {
      return res.status(403).json({
        error: req.t('emails.reminderSchedules.errors.featureDisabled'),
      });
    }

    const models = req.app.get('db_model');
    const company = await getCompany(req);
    const {startDate, endDate, limit} = req.query;

    const reminderScheduler = require('../model/leave/reminder_scheduler');
    const notifications = await reminderScheduler.getReminderSummary({
      models,
      companyId: company.id,
      startDate,
      endDate,
    });

    return res.json({
      notifications: notifications.slice(0, parseInt(limit, 10) || 50),
    });
  } catch (error) {
    console.error('Get reminder history error:', error);
    return res.status(500).json({
      error: req.t('emails.reminderSchedules.errors.historyFailed'),
    });
  }
}

/**
 * POST /api/reminder-schedules/test-send
 *
 * Send test reminder email
 */
async function testSend(req, res) {
  try {
    if (!features.isEnabled('leave_start_reminders')) {
      return res.status(403).json({
        error: req.t('emails.reminderSchedules.errors.featureDisabled'),
      });
    }

    const models = req.app.get('db_model');
    const company = await getCompany(req);
    const {leaveId, daysBefore} = req.body;

    if (!leaveId) {
      return res.status(400).json({
        error: req.t('emails.reminderSchedules.errors.leaveIdRequired'),
      });
    }

    const parsedDays = parseDays(daysBefore);
    if (!parsedDays) {
      return res.status(400).json({
        error: req.t('emails.reminderSchedules.errors.daysBeforeRange'),
      });
    }

    // Get leave
    const leave = await models.Leave.findOne({
      where: {id: leaveId},
      include: [
        {
          model: models.User,
          as: 'user',
          include: [{
            model: models.Department,
            as: 'department',
            include: [{model: models.User, as: 'boss'}],
          }],
        },
        {model: models.LeaveType, as: 'leave_type'},
      ],
    });

    if (!leave) {
      return res.status(404).json({
        error: req.t('emails.reminderSchedules.errors.leaveNotFound'),
      });
    }

    if (leave.user.companyId !== company.id) {
      return res.status(403).json({
        error: req.t('emails.reminderSchedules.errors.leaveForbidden'),
      });
    }

    // Send test email to current user
    // Lazy require: lib/email pulls in model/db, which must not load while
    // edition initialization is still in progress.
    const Email = require('../email');
    const emailTransport = new Email();

    await emailTransport.promise_upcoming_leave_start_reminder_email({
      leave,
      recipient: req.user,
      employee: leave.user,
      department: leave.user.department,
      notification_type: 'test_reminder',
      daysBefore: parsedDays,
    });

    return res.json({
      success: true,
      message: req.t('emails.reminderSchedules.status.testEmailSent'),
      sentTo: req.user.email,
    });
  } catch (error) {
    console.error('Test send error:', error);
    return res.status(500).json({
      error: req.t('emails.reminderSchedules.errors.testSendFailed'),
    });
  }
}

/*
  Paths are relative to the mount, which is '/api/reminder-schedules' and
  '/settings/reminder-schedules/' respectively - see lib/edition/community.js.
  They used to be absolute, which only worked because the routers were mounted
  at '/', and mounting them there dragged their admin gate across every other
  route in the application.
*/
module.exports = {
  registerApi: function(app) {
    app.get('/', listSchedules);
    app.post('/', createSchedule);
    app.get('/history', getHistory);
    app.post('/test-send', testSend);
    app.put('/:id', updateSchedule);
    app.delete('/:id', deleteSchedule);
  },
  registerSettings: function(app) {
    app.get('/', showReminderSchedules);
  },
};
