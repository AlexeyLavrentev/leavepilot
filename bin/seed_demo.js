'use strict';

const log = require('../lib/middleware/request_logger');

/*
 * Demo data seeder: creates a demo company with departments, employees and
 * a realistic mix of approved/pending leaves, so a pilot installation shows
 * a populated calendar instead of an empty screen.
 *
 * Usage:
 *   npm run seed-demo
 *   npm run seed-demo -- --email demo-admin@example.com --password secret123
 *
 * Options:
 *   --email     demo admin email (default: demo-admin@example.local)
 *   --password  demo admin password; generated and printed if omitted
 *   --company   demo company name (default: "Демо компания")
 *   --country   ISO country code (default: RU)
 */

const argv = require('minimist')(process.argv.slice(2));
const crypto = require('crypto');
const dayjs = require('../lib/util/date');

const models = require('../lib/model/db');

const adminEmail = String(argv.email || 'demo-admin@example.local').trim().toLowerCase();
const companyName = String(argv.company || 'Демо компания').trim();
const countryCode = String(argv.country || 'RU').trim().toUpperCase();
const password = argv.password ? String(argv.password) : crypto.randomBytes(9).toString('base64url');
const generatedPassword = !argv.password;

const DEPARTMENTS = ['ИТ', 'Бухгалтерия', 'Маркетинг'];

const EMPLOYEES = [
  {name: 'Иван', lastname: 'Петров'},
  {name: 'Мария', lastname: 'Смирнова'},
  {name: 'Алексей', lastname: 'Козлов'},
  {name: 'Елена', lastname: 'Волкова'},
  {name: 'Дмитрий', lastname: 'Соколов'},
  {name: 'Анна', lastname: 'Морозова'},
  {name: 'Сергей', lastname: 'Лебедев'},
  {name: 'Ольга', lastname: 'Новикова'},
  {name: 'Павел', lastname: 'Федоров'},
  {name: 'Наталья', lastname: 'Киселева'},
  {name: 'Андрей', lastname: 'Богданов'},
  {name: 'Татьяна', lastname: 'Орлова'},
];

function transliterate(value) {
  const map = {
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',
    м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',
    ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',ё:'e',
  };
  return value.toLowerCase().split('').map(function(char) {
    return Object.prototype.hasOwnProperty.call(map, char) ? map[char] : char;
  }).join('');
}

async function seed() {
  await models.connect();

  const existing = await models.User.find_by_email(adminEmail);
  if (existing) {
    throw new Error(
      'Demo admin ' + adminEmail + ' already exists. '
      + 'Pass a different --email or remove the previous demo company first.'
    );
  }

  const admin = await models.User.register_new_admin_user({
    email        : adminEmail,
    password     : password,
    name         : 'Демо',
    lastname     : 'Администратор',
    company_name : companyName,
    country_code : countryCode,
    activated    : true,
  });

  const company = await models.Company.findOne({where: {id: admin.companyId}});
  const leaveTypes = await models.LeaveType.findAll({where: {companyId: company.id}});
  const mainLeaveType = leaveTypes[0];
  const altLeaveType = leaveTypes[1] || leaveTypes[0];

  const firstDepartment = await models.Department.findOne({where: {companyId: company.id}});
  const departments = [firstDepartment];

  for (let i = 0; i < DEPARTMENTS.length; i++) {
    departments.push(await models.Department.create({
      name      : DEPARTMENTS[i],
      companyId : company.id,
      allowance : firstDepartment.allowance,
      bossId    : admin.id,
    }));
  }

  const emailDomain = adminEmail.split('@')[1];
  const users = [];

  for (let j = 0; j < EMPLOYEES.length; j++) {
    const person = EMPLOYEES[j];
    const department = departments[j % departments.length];
    const user = await models.User.create({
      name         : person.name,
      lastname     : person.lastname,
      email        : transliterate(person.name) + '.' + transliterate(person.lastname) + '@' + emailDomain,
      password     : models.User.hashify_password(password),
      companyId    : company.id,
      DepartmentId : department.id,
      admin        : false,
      activated    : true,
    });
    users.push(user);
  }

  const today = dayjs.utc().startOf('day');
  let leavesCreated = 0;

  async function createLeave(user, startOffsetDays, lengthDays, status, leaveType) {
    const start = today.clone().add(startOffsetDays, 'days');
    const end = start.clone().add(lengthDays - 1, 'days');

    await models.Leave.create({
      userId         : user.id,
      approverId     : status === models.Leave.status_new() ? null : admin.id,
      leaveTypeId    : leaveType.id,
      status         : status,
      date_start     : start.format('YYYY-MM-DD'),
      date_end       : end.format('YYYY-MM-DD'),
      day_part_start : models.Leave.leave_day_part_all(),
      day_part_end   : models.Leave.leave_day_part_all(),
    });
    leavesCreated += 1;
  }

  for (let k = 0; k < users.length; k++) {
    const employee = users[k];

    // Everyone took a leave earlier this year
    await createLeave(employee, -60 + k * 3, 7, models.Leave.status_approved(), mainLeaveType);

    // A third of the team is away around today
    if (k % 3 === 0) {
      await createLeave(employee, -2 + (k % 4), 5, models.Leave.status_approved(), mainLeaveType);
    }

    // Upcoming approved vacations spread over next weeks
    if (k % 2 === 0) {
      await createLeave(employee, 14 + k * 2, 7, models.Leave.status_approved(), mainLeaveType);
    }

    // A few pending requests for the approver to look at
    if (k % 4 === 1) {
      await createLeave(employee, 30 + k, 3, models.Leave.status_new(), altLeaveType);
    }
  }

  return {
    company       : companyName,
    admin         : adminEmail,
    users         : users.length,
    departments   : departments.length,
    leaves        : leavesCreated,
  };
}

seed()
  .then(function(summary) {
    log.info('demo_data_created', {
      company: summary.company,
      departments: summary.departments,
      employees: summary.users,
      leaves: summary.leaves,
    });
    log.info('demo_signin', { url: '/login/', email: summary.admin });
    if (generatedPassword) {
      log.info('demo_password', { password });
    }
    log.info('demo_password_shared');
    return models.sequelize.close();
  })
  .catch(function(error) {
    log.error('seed_demo_failed', { error: error && error.stack || String(error) });
    return models.sequelize.close()
      .catch(function() {})
      .then(function() {
        process.exit(1);
      });
  });
