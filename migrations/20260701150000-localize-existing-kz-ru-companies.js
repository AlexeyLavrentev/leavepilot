'use strict';

// Локализация уже существующих компаний KZ/RU.
//
// Стратегия безопасности: обновляются ТОЛЬКО записи, точно совпадающие
// с исходными английскими дефолтами (нетронутые). Если компания уже
// переименовала отдел, тип отсутствия, праздник или сменила формат даты —
// её данные не трогаем.

var dayjs = require('../lib/util/date');

var COUNTRIES = ['KZ', 'RU'];

function findCompanies(queryInterface, Sequelize) {
  var table = queryInterface.queryGenerator.quoteTable('Companies');
  var id = queryInterface.queryGenerator.quoteIdentifier('id');
  var country = queryInterface.queryGenerator.quoteIdentifier('country');
  var dateFormat = queryInterface.queryGenerator.quoteIdentifier('date_format');
  return queryInterface.sequelize.query(
    'SELECT ' + id + ', ' + country + ', ' + dateFormat + ' FROM ' + table
      + ' WHERE ' + country + ' IN (:countries)',
    {
      replacements: { countries: COUNTRIES },
      type: Sequelize.QueryTypes.SELECT,
    }
  );
}

function findBankHolidays(queryInterface, Sequelize, companyId) {
  var table = queryInterface.queryGenerator.quoteTable('BankHolidays');
  var id = queryInterface.queryGenerator.quoteIdentifier('id');
  var name = queryInterface.queryGenerator.quoteIdentifier('name');
  var date = queryInterface.queryGenerator.quoteIdentifier('date');
  var company = queryInterface.queryGenerator.quoteIdentifier('companyId');
  return queryInterface.sequelize.query(
    'SELECT ' + id + ', ' + name + ', ' + date + ', ' + company + ' FROM ' + table
      + ' WHERE ' + company + ' = :companyId',
    {
      replacements: { companyId: companyId },
      type: Sequelize.QueryTypes.SELECT,
    }
  );
}

// Дата -> { en: старое англ. имя, ru: новое рус. имя } для праздников 2026.
// Используется для переименования только нетронутых записей.
var RENAME_2026 = {
  KZ: {
    '2026-01-01': { en: 'New Year',                        ru: 'Новый год' },
    '2026-01-02': { en: 'New Year',                        ru: 'Новый год' },
    '2026-01-07': { en: 'Orthodox Christmas',              ru: 'Православное Рождество' },
    '2026-03-08': { en: "International Women's Day",        ru: 'Международный женский день' },
    '2026-03-21': { en: 'Nauryz',                          ru: 'Наурыз' },
    '2026-03-22': { en: 'Nauryz',                          ru: 'Наурыз' },
    '2026-03-23': { en: 'Nauryz',                          ru: 'Наурыз' },
    '2026-05-01': { en: 'Unity Day',                       ru: 'Праздник единства народа Казахстана' },
    '2026-05-07': { en: 'Defender of the Fatherland Day',  ru: 'День защитника Отечества' },
    '2026-05-09': { en: 'Victory Day',                     ru: 'День Победы' },
    '2026-05-27': { en: 'Kurban Ait',                      ru: 'Курбан айт' },
    '2026-07-06': { en: 'Capital City Day',                ru: 'День столицы' },
    '2026-08-30': { en: 'Constitution Day',                ru: 'День Конституции' },
    '2026-10-25': { en: 'Republic Day',                    ru: 'День Республики' },
    '2026-12-16': { en: 'Independence Day',                ru: 'День Независимости' },
  },
  RU: {
    '2026-01-01': { en: 'New Year Holidays',               ru: 'Новогодние каникулы' },
    '2026-01-02': { en: 'New Year Holidays',               ru: 'Новогодние каникулы' },
    '2026-01-03': { en: 'New Year Holidays',               ru: 'Новогодние каникулы' },
    '2026-01-04': { en: 'New Year Holidays',               ru: 'Новогодние каникулы' },
    '2026-01-05': { en: 'New Year Holidays',               ru: 'Новогодние каникулы' },
    '2026-01-06': { en: 'New Year Holidays',               ru: 'Новогодние каникулы' },
    '2026-01-07': { en: 'Christmas',                       ru: 'Рождество Христово' },
    '2026-01-08': { en: 'New Year Holidays',               ru: 'Новогодние каникулы' },
    '2026-02-23': { en: 'Defender of the Fatherland Day',  ru: 'День защитника Отечества' },
    '2026-03-08': { en: "International Women's Day",        ru: 'Международный женский день' },
    '2026-05-01': { en: 'Spring and Labour Day',           ru: 'Праздник Весны и Труда' },
    '2026-05-09': { en: 'Victory Day',                     ru: 'День Победы' },
    '2026-06-12': { en: 'Russia Day',                      ru: 'День России' },
    '2026-11-04': { en: 'Unity Day',                       ru: 'День народного единства' },
  },
};

// Праздники 2027 — добавляются, только если на эту дату у компании
// ещё нет ни одного праздника (чтобы не плодить дубли).
var ADD_2027 = {
  KZ: [
    { date: '2027-01-01', name: 'Новый год' },
    { date: '2027-01-02', name: 'Новый год' },
    { date: '2027-01-07', name: 'Православное Рождество' },
    { date: '2027-03-08', name: 'Международный женский день' },
    { date: '2027-03-21', name: 'Наурыз' },
    { date: '2027-03-22', name: 'Наурыз' },
    { date: '2027-03-23', name: 'Наурыз' },
    { date: '2027-05-01', name: 'Праздник единства народа Казахстана' },
    { date: '2027-05-07', name: 'День защитника Отечества' },
    { date: '2027-05-09', name: 'День Победы' },
    { date: '2027-05-17', name: 'Курбан айт' },
    { date: '2027-07-06', name: 'День столицы' },
    { date: '2027-08-30', name: 'День Конституции' },
    { date: '2027-10-25', name: 'День Республики' },
    { date: '2027-12-16', name: 'День Независимости' },
  ],
  RU: [
    { date: '2027-01-01', name: 'Новогодние каникулы' },
    { date: '2027-01-02', name: 'Новогодние каникулы' },
    { date: '2027-01-03', name: 'Новогодние каникулы' },
    { date: '2027-01-04', name: 'Новогодние каникулы' },
    { date: '2027-01-05', name: 'Новогодние каникулы' },
    { date: '2027-01-06', name: 'Новогодние каникулы' },
    { date: '2027-01-07', name: 'Рождество Христово' },
    { date: '2027-01-08', name: 'Новогодние каникулы' },
    { date: '2027-02-23', name: 'День защитника Отечества' },
    { date: '2027-03-08', name: 'Международный женский день' },
    { date: '2027-05-01', name: 'Праздник Весны и Труда' },
    { date: '2027-05-09', name: 'День Победы' },
    { date: '2027-06-12', name: 'День России' },
    { date: '2027-11-04', name: 'День народного единства' },
  ],
};

// Дефолтные названия отдела и типов отсутствий (en -> ru).
var DEPARTMENT_RENAME = { en: 'Sales', ru: 'Продажи' };
var LEAVE_TYPE_RENAME = [
  { en: 'Holiday',    ru: 'Отпуск' },
  { en: 'Sick Leave', ru: 'Больничный' },
];

function dateKey(value) {
  return dayjs.utc(value).format('YYYY-MM-DD');
}

module.exports = {
  up: function (queryInterface, Sequelize) {
    return findCompanies(queryInterface, Sequelize)
      .then(function (companies) {
        return companies.reduce(function (chain, company) {
          var cc = company.country;

          return chain.then(function () {
            var tasks = [];

            // 1. Формат даты — только если остался исходный дефолт.
            if (company.date_format === 'YYYY-MM-DD') {
              tasks.push(queryInterface.bulkUpdate(
                'Companies',
                { date_format: 'DD.MM.YYYY' },
                { id: company.id }
              ));
            }

            // 2. Название отдела — только нетронутый дефолт.
            tasks.push(queryInterface.bulkUpdate(
              'Departments',
              { name: DEPARTMENT_RENAME.ru },
              { companyId: company.id, name: DEPARTMENT_RENAME.en }
            ));

            // 3. Названия типов отсутствий — только нетронутые дефолты.
            LEAVE_TYPE_RENAME.forEach(function (map) {
              tasks.push(queryInterface.bulkUpdate(
                'LeaveTypes',
                { name: map.ru },
                { companyId: company.id, name: map.en }
              ));
            });

            return Promise.all(tasks);
          })
          // 4. Праздники: переименование 2026 + добавление 2027.
          .then(function () {
            return findBankHolidays(queryInterface, Sequelize, company.id);
          })
          .then(function (holidays) {
            var renameMap = RENAME_2026[cc] || {};
            var existingDates = {};
            var renameTasks = [];

            holidays.forEach(function (bh) {
              var key = dateKey(bh.date);
              existingDates[key] = true;

              var expected = renameMap[key];
              if (expected && bh.name === expected.en) {
                renameTasks.push(queryInterface.bulkUpdate(
                  'BankHolidays',
                  { name: expected.ru },
                  { id: bh.id }
                ));
              }
            });

            var toAdd = (ADD_2027[cc] || [])
              .filter(function (h) { return !existingDates[h.date]; })
              .map(function (h) {
                var now = new Date();
                return {
                  name: h.name,
                  date: h.date,
                  companyId: company.id,
                  createdAt: now,
                  updatedAt: now,
                };
              });

            if (toAdd.length) {
              renameTasks.push(queryInterface.bulkInsert('BankHolidays', toAdd));
            }

            return Promise.all(renameTasks);
          });
        }, Promise.resolve());
      });
  },

  down: function (queryInterface, Sequelize) {
    return findCompanies(queryInterface, Sequelize)
      .then(function (companies) {
        return companies.reduce(function (chain, company) {
          var cc = company.country;

          return chain.then(function () {
            var tasks = [];

            // 1. Формат даты обратно.
            if (company.date_format === 'DD.MM.YYYY') {
              tasks.push(queryInterface.bulkUpdate(
                'Companies',
                { date_format: 'YYYY-MM-DD' },
                { id: company.id }
              ));
            }

            // 2. Отдел обратно.
            tasks.push(queryInterface.bulkUpdate(
              'Departments',
              { name: DEPARTMENT_RENAME.en },
              { companyId: company.id, name: DEPARTMENT_RENAME.ru }
            ));

            // 3. Типы отсутствий обратно.
            LEAVE_TYPE_RENAME.forEach(function (map) {
              tasks.push(queryInterface.bulkUpdate(
                'LeaveTypes',
                { name: map.en },
                { companyId: company.id, name: map.ru }
              ));
            });

            return Promise.all(tasks);
          })
          .then(function () {
            return findBankHolidays(queryInterface, Sequelize, company.id);
          })
          .then(function (holidays) {
            var renameMap = RENAME_2026[cc] || {};
            var add2027Dates = {};
            (ADD_2027[cc] || []).forEach(function (h) { add2027Dates[h.date] = h.name; });

            var tasks = [];

            holidays.forEach(function (bh) {
              var key = dateKey(bh.date);

              // Переименование 2026 обратно в английский.
              var expected = renameMap[key];
              if (expected && bh.name === expected.ru) {
                tasks.push(queryInterface.bulkUpdate(
                  'BankHolidays',
                  { name: expected.en },
                  { id: bh.id }
                ));
                return;
              }

              // Удаление добавленных 2027 (по дате и имени).
              if (add2027Dates[key] && add2027Dates[key] === bh.name) {
                tasks.push(queryInterface.bulkDelete('BankHolidays', { id: bh.id }));
              }
            });

            return Promise.all(tasks);
          });
        }, Promise.resolve());
      });
  },
};
