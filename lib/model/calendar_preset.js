"use strict";

const dayjs = require('../util/date');
const config = require('../config');
const workCalendar = require('./work_calendar');

const IMPORT_SOURCE = 'official_preset';
const WEEK_TYPE_FIVE_DAY = 'five_day';
const WEEK_TYPE_SIX_DAY = 'six_day';

const transferredDays = {
  KZ : {
    2026 : {
      five_day : [
        ['2026-03-09', 'Transferred day off'],
        ['2026-03-24', 'Transferred Nauryz day off'],
        ['2026-03-25', 'Transferred Nauryz day off'],
        ['2026-05-11', 'Transferred Victory Day off'],
        ['2026-08-31', 'Transferred Constitution Day off'],
        ['2026-10-26', 'Transferred Republic Day off'],
      ],
      six_day : [
        ['2026-03-09', 'Transferred day off'],
        ['2026-03-24', 'Transferred Nauryz day off'],
        ['2026-08-31', 'Transferred Constitution Day off'],
        ['2026-10-26', 'Transferred Republic Day off'],
      ],
    },
  },
  RU : {
    2026 : {
      five_day : [
        ['2026-01-09', 'Transferred New Year day off'],
        ['2026-03-09', "Transferred International Women's Day off"],
        ['2026-05-11', 'Transferred Victory Day off'],
        ['2026-12-31', 'Transferred New Year day off'],
      ],
      six_day : [],
    },
  },
};

const dateKey = day => dayjs.utc(day.date).format('YYYY-MM-DD');

const getPresetDays = ({country, year, weekType = WEEK_TYPE_FIVE_DAY}) => {
  const countries = config.get('countries') || {};
  const preset = countries[country] || {};
  const additions = (
    transferredDays[country]
    && transferredDays[country][year]
    && transferredDays[country][year][weekType]
  ) || [];

  return (preset.bank_holidays || [])
    .filter(day => dayjs.utc(day.date).year() === Number(year))
    .concat(additions.map(([date, name]) => ({date, name})))
    .map(day => ({
      name          : day.name,
      date          : dateKey(day),
      day_type      : workCalendar.DAY_TYPE_NON_WORKING,
      import_source : IMPORT_SOURCE,
    }));
};

const buildPreview = ({country, year, weekType, bankHolidays}) => {
  const commonDays = (bankHolidays || []).filter(day => !day.workCalendarId);
  const existingByDate = {};

  commonDays.forEach(day => { existingByDate[dateKey(day)] = day; });

  return getPresetDays({country, year, weekType}).map(day => {
    const existing = existingByDate[dateKey(day)];

    if (!existing) {
      return {...day, action : 'add'};
    }

    if (existing.import_source === IMPORT_SOURCE && (
      existing.name !== day.name || existing.day_type !== day.day_type
    )) {
      return {...day, id : existing.id, action : 'update'};
    }

    return {...day, id : existing.id, action : 'keep'};
  });
};

const applyPreset = async ({model, company, year, weekType}) => {
  const preview = buildPreview({
    country      : company.country,
    year,
    weekType,
    bankHolidays : company.bank_holidays,
  });
  const changed = preview.filter(day => day.action !== 'keep');

  await Promise.all(changed.map(day => {
    if (day.action === 'update') {
      return model.BankHoliday.update({
        name          : day.name,
        day_type      : day.day_type,
        import_source : IMPORT_SOURCE,
      }, {
        where : { id : day.id, companyId : company.id },
      });
    }

    return model.BankHoliday.create({
      name          : day.name,
      date          : day.date,
      day_type      : day.day_type,
      import_source : IMPORT_SOURCE,
      companyId     : company.id,
    });
  }));

  return changed;
};

module.exports = {
  IMPORT_SOURCE,
  WEEK_TYPE_FIVE_DAY,
  WEEK_TYPE_SIX_DAY,
  getPresetDays,
  buildPreview,
  applyPreset,
};
