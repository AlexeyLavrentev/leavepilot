
"use strict";

const express = require('express'),
  dayjs = require('../util/date'),
  router    = express.Router(),
  validator = require('../util/validator'),
  Exception = require('../error'),
  features  = require('../features'),
  log       = require('../logger'),
  CalendarMonth       = require('../model/calendar_month'),
  workCalendar        = require('../model/work_calendar'),
  calendarPreset      = require('../model/calendar_preset');

// Make sure that current user is authorized to deal with settings
router.all(/.*/, require('../middleware/ensure_user_is_admin'));

const getCurrentYear = ({req}) => {
  const rawYear = req.query['year'] || (req.body || {})['year'];
  return (
    validator.isNumeric(rawYear)
    ? dayjs.utc(rawYear, 'YYYY')
    : req.user.company.get_today()
  ).year();
};

const getWorkCalendarId = req => validator.isNumeric(req.query['work_calendar'] || (req.body || {})['work_calendar_id'])
  ? Number(req.query['work_calendar'] || (req.body || {})['work_calendar_id'])
  : null;

const getWorkCalendarQuery = ({year, workCalendarId}) => (
  `?year=${year}${workCalendarId ? `&work_calendar=${workCalendarId}` : ''}`
);

const getWeekType = req => (
  req.query['week_type'] === calendarPreset.WEEK_TYPE_SIX_DAY
  || (req.body || {})['week_type'] === calendarPreset.WEEK_TYPE_SIX_DAY
    ? calendarPreset.WEEK_TYPE_SIX_DAY
    : calendarPreset.WEEK_TYPE_FIVE_DAY
);

const validateWorkCalendarId = ({company, workCalendarId}) => {
  if (!workCalendarId) {
    return null;
  }

  const exists = (company.work_calendars || [])
    .some(calendar => String(calendar.id) === String(workCalendarId));

  if (!exists) {
    throw new Error(`Unknown work calendar [${workCalendarId}] for company [${company.id}]`);
  }

  return workCalendarId;
};

router.get('/bankholidays/', (req, res) => {

  res.locals.custom_java_script.push(
    '/js/bank_holidays.js'
  );

  const currentYear = getCurrentYear({req});
  const workCalendarsEnabled = features.isEnabled('work_calendars');
  const workCalendarId = workCalendarsEnabled ? getWorkCalendarId(req) : null;
  const weekType = getWeekType(req);

  req.user.getCompany({
    scope : ['with_bank_holidays', 'order_by_bank_holidays', 'with_work_calendars'],
  })
  .then((company) => {
    const selectedWorkCalendar = company.work_calendars
      .find(calendar => String(calendar.id) === String(workCalendarId));
    const department = { WorkCalendarId : selectedWorkCalendar ? selectedWorkCalendar.id : null };
    const today = dayjs.utc();
    const bankHolidays = company.bank_holidays
      .filter(bh => dayjs.utc(bh.date).year() === currentYear)
      .filter(bh => String(bh.workCalendarId || '') === String(department.WorkCalendarId || ''));
    const effectiveDays = workCalendar.getDaysForDepartment({
      bankHolidays : company.bank_holidays,
      department,
    });
    const importPreview = selectedWorkCalendar || !workCalendarsEnabled
      ? []
      : calendarPreset.buildPreview({
        country      : company.country,
        year         : currentYear,
        weekType,
        bankHolidays : company.bank_holidays,
      });
    const calendar = [...Array(12).keys()]
      .map(i => i+1)
      .map(m => new CalendarMonth(
          `${currentYear}-${String(m).padStart(2, '0')}`,
          {
            today,
            schedule: {is_it_working_day: ({day}) => dayjs.utc(day).isoWeekday() < 6},
            bank_holidays: effectiveDays.filter(day => day.day_type !== workCalendar.DAY_TYPE_WORKING),
            working_day_overrides: effectiveDays.filter(day => day.day_type === workCalendar.DAY_TYPE_WORKING),
            locale: req.language || 'en',
          }
        )
      )
      .map(cm => cm.as_for_template());

    res.render('bankHolidays', {
      title: req.t('bankHolidays.title'),
      company,
      calendar,
      bankHolidays,
      workCalendars: workCalendarsEnabled ? company.work_calendars : [],
      selectedWorkCalendar,
      workCalendarId: department.WorkCalendarId,
      dayTypeNonWorking: workCalendar.DAY_TYPE_NON_WORKING,
      dayTypeWorking: workCalendar.DAY_TYPE_WORKING,
      yearCurrent: currentYear,
      yearPrev: currentYear - 1,
      yearNext: currentYear + 1,
      startDateOfYearCurrent: dayjs.utc(currentYear, 'YYYY'),
      importPreview,
      importChangesCount: importPreview.filter(day => day.action !== 'keep').length,
      weekType,
      weekTypeFiveDay: calendarPreset.WEEK_TYPE_FIVE_DAY,
      weekTypeSixDay: calendarPreset.WEEK_TYPE_SIX_DAY,
    });
  });
});

const getNewBankHolidayAttributes = ({req, companyId, workCalendarId}) => {
  if (
    !validator.trim(req.body['name__new'])
    && !validator.trim(req.body['date__new'])
  ) {
    return null;
  }

  const attributes = getAndValidateBankHoliday({
    req,
    id: 'new',
    itemName : 'New Bank Holiday',
  });

  return {...attributes, companyId, workCalendarId};
};

router.post('/bankholidays/', function(req,res){
  const model= req.app.get('db_model');
  const currentYear = getCurrentYear({req});
  const workCalendarId = getWorkCalendarId(req);

  if (workCalendarId && !features.isEnabled('work_calendars')) {
    req.session.flash_error(req.t('features.messages.disabled'));
    return res.redirect_with_session(`/settings/bankholidays/?year=${currentYear}`);
  }

  req.user.getCompany({
    scope : ['with_bank_holidays', 'with_work_calendars'],
  })
  .then((company) => {
    validateWorkCalendarId({company, workCalendarId});
    const newBankHolidayAttributes = getNewBankHolidayAttributes({
      req,
      companyId: company.id,
      workCalendarId,
    });
    const existingBankHolidayUpdates = company.bank_holidays
      .filter(bankHoliday => String(bankHoliday.workCalendarId || '') === String(workCalendarId || ''))
      .map(bankHoliday => {
        const attributes = getAndValidateBankHoliday({
          req,
          id: bankHoliday.id,
          itemName: bankHoliday.name,
        });

        return {bankHoliday, attributes};
      });

    if (req.session.flash_has_errors()) {
      return null;
    }

    return Promise.all([
      newBankHolidayAttributes
        ? model.BankHoliday.create(newBankHolidayAttributes)
        : Promise.resolve(1),
      ...existingBankHolidayUpdates.map(({bankHoliday, attributes}) =>
        bankHoliday.update(attributes)
      ),
    ]);
  })
  .then(() => {
    if (!req.session.flash_has_errors()) {
      req.session.flash_message(req.t('bankHolidays.messages.saved'));
    }
  })
  .catch((error) => {
    log.error('bank holiday edit failed', { userId: req.user.id, err: error.message });

    req.session.flash_error(req.t('bankHolidays.messages.updateFailed'));
  })
  .then(() => {
    return res.redirect_with_session(`/settings/bankholidays/${getWorkCalendarQuery({year: currentYear, workCalendarId})}`);
  });
});

router.post('/bankholidays/import/', (req, res) => {
  if (!features.isEnabled('work_calendars')) {
    req.session.flash_error(req.t('features.messages.disabled'));
    return res.redirect_with_session('/settings/bankholidays/');
  }

  const model = req.app.get('db_model'),
    currentYear = getCurrentYear({req}),
    weekType = getWeekType(req);

  Promise.resolve()
      .then(() => req.user.getCompany({
      scope : ['with_bank_holidays'],
    }))
    .then(company => calendarPreset.applyPreset({model, company, year : currentYear, weekType}))
    .then(changedDays => {

      if (changedDays.length > 0) {
        req.session.flash_message(req.t('bankHolidays.messages.importAdded', {
          names: changedDays.map(day => day.name).join(', ')
        }));
      } else {

        req.session.flash_message(req.t('bankHolidays.messages.importNone'));
      }
    })
    .catch(error => {

      console.log(
        'An error occurred when trying to import default bank holidays by user '+req.user.id
      );
      console.dir(error);

      if ( error && error.tom_error) {
        req.session.flash_error( Exception.extract_user_error_message(error) );
      }

      req.session.flash_error(req.t('bankHolidays.messages.importFailed'));
    })
    .then(() => {
      return res.redirect_with_session(`/settings/bankholidays/?year=${currentYear}&week_type=${weekType}`);
    });
});

router.post('/bankholidays/delete/:bankHolidayId/', function(req, res){
  const currentYear = getCurrentYear({req});
  const workCalendarId = getWorkCalendarId(req);
  const bankHolidayId = req.params['bankHolidayId'];

  if (!validator.isInt(bankHolidayId)) {
    console.error(`User ${req.user.id} submitted non-INT bank holiday ID ${bankHolidayId}`);
    req.session.flash_error(req.t('bankHolidays.messages.removeWrongParams'));
    return res.redirect_with_session(`/settings/bankholidays/${getWorkCalendarQuery({year: currentYear, workCalendarId})}`);
  }

  req.user.getCompany({
    scope : ['with_bank_holidays'],
  })
  .then(company => {
    const bankHolidayToRemove = company.bank_holidays.find(bh => String(bh.id) === String(bankHolidayId));

    // Check if user specify valid department number
    if (! bankHolidayToRemove) {
      console.error(
        `User ${req.user.id} tried to remove non-existing bank holiday number ${bankHolidayId}`
      );
      req.session.flash_error(req.t('bankHolidays.messages.removeWrongParams'));

      throw new Error(`Unknown bank holiday [${bankHolidayId}]`);
    }

    if (bankHolidayToRemove.workCalendarId && !features.isEnabled('work_calendars')) {
      req.session.flash_error(req.t('features.messages.disabled'));
      throw new Error(`Work calendar feature disabled for bank holiday [${bankHolidayId}]`);
    }

    return bankHolidayToRemove.destroy();
  })
  .then(() => {
    req.session.flash_message(req.t('bankHolidays.messages.removed'));
    return res.redirect_with_session(`/settings/bankholidays/${getWorkCalendarQuery({year: currentYear, workCalendarId})}`);
  })
  .catch(error => {
    console.error(`Failed to remove bank holiday [${bankHolidayId}]: ${error}`);
    return res.redirect_with_session(`/settings/bankholidays/${getWorkCalendarQuery({year: currentYear, workCalendarId})}`);
  });
});

router.post('/bankholidays/calendars/', function(req, res){
  if (!features.isEnabled('work_calendars')) {
    req.session.flash_error(req.t('features.messages.disabled'));
    return res.redirect_with_session('/settings/bankholidays/');
  }

  const name = validator.trim(req.body['name'] || '');
  const model = req.app.get('db_model');

  if (!name) {
    req.session.flash_error(req.t('bankHolidays.messages.calendarNameRequired'));
    return res.redirect_with_session('/settings/bankholidays/');
  }

  model.WorkCalendar.findAll({
    where : { companyId : req.user.companyId },
  })
    .then(calendars => {
      const duplicate = calendars.some(calendar =>
        String(calendar.name).trim().toLocaleLowerCase()
        === name.toLocaleLowerCase()
      );

      if (duplicate) {
        req.session.flash_error(req.t('bankHolidays.messages.calendarNameDuplicate'));
        return null;
      }

      return model.WorkCalendar.create({ name, companyId : req.user.companyId });
    })
    .then(calendar => {
      if (calendar) {
        req.session.flash_message(req.t('bankHolidays.messages.calendarCreated', { name : calendar.name }));
        return res.redirect_with_session(`/settings/bankholidays/?work_calendar=${calendar.id}`);
      }

      return res.redirect_with_session('/settings/bankholidays/');
    })
    .catch(error => {
      console.error(`Failed to create work calendar for company [${req.user.companyId}]: ${error}`);
      req.session.flash_error(req.t('bankHolidays.messages.calendarCreateFailed'));
      return res.redirect_with_session('/settings/bankholidays/');
    });
});

router.post('/bankholidays/calendars/delete/:workCalendarId/', function(req, res){
  if (!features.isEnabled('work_calendars')) {
    req.session.flash_error(req.t('features.messages.disabled'));
    return res.redirect_with_session('/settings/bankholidays/');
  }

  const model = req.app.get('db_model');
  const workCalendarId = req.params['workCalendarId'];

  if (!validator.isInt(workCalendarId)) {
    req.session.flash_error(req.t('bankHolidays.messages.calendarRemoveWrongParams'));
    return res.redirect_with_session('/settings/bankholidays/');
  }

  model.WorkCalendar.findOne({
    where : {
      id        : workCalendarId,
      companyId : req.user.companyId,
    },
  })
  .then(calendar => {
    if (!calendar) {
      throw new Error(`Unknown work calendar [${workCalendarId}]`);
    }

    return model.Department.count({ where : { WorkCalendarId : calendar.id } })
      .then(departmentCount => {
        if (departmentCount > 0) {
          req.session.flash_error(req.t('bankHolidays.messages.calendarRemoveHasDepartments'));
          return null;
        }

        return model.BankHoliday.destroy({ where : { workCalendarId : calendar.id } })
          .then(() => calendar.destroy());
      });
  })
  .then(calendar => {
    if (calendar) {
      req.session.flash_message(req.t('bankHolidays.messages.calendarRemoved'));
    }
    return res.redirect_with_session('/settings/bankholidays/');
  })
  .catch(error => {
    console.error(`Failed to remove work calendar [${workCalendarId}]: ${error}`);
    req.session.flash_error(req.t('bankHolidays.messages.calendarRemoveFailed'));
    return res.redirect_with_session('/settings/bankholidays/');
  });
});

const getAndValidateBankHoliday = ({req, id, itemName}) => {

  // Get user parameters
  let name = validator.trim(req.body[`name__${id}`]),
      date = validator.trim(req.body[`date__${id}`]),
      day_type = validator.trim(req.body[`day_type__${id}`] || workCalendar.DAY_TYPE_NON_WORKING);

  // Nothing to validate, abort
  if (!name && !date) {
    return {};
  }

  // Validate provided parameters
  //
  // Note, we allow users to put whatever they want into the name.
  // The XSS defence is in the templates

  date = req.user.company.normalise_date( date );

  if (!name) {
    req.session.flash_error(req.t('bankHolidays.messages.nameRequired', {
      name: itemName
    }));
  }

  if (!validator.isDate(date) ) {
    req.session.flash_error(req.t('bankHolidays.messages.dateInvalid', {
      name: itemName
    }));
  }

  if ([workCalendar.DAY_TYPE_NON_WORKING, workCalendar.DAY_TYPE_WORKING].indexOf(day_type) === -1) {
    req.session.flash_error(req.t('bankHolidays.messages.dayTypeInvalid', { name: itemName }));
  }

  return { name, date, day_type };
}

module.exports = router;
