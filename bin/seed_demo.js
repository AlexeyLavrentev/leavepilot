'use strict';

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

var argv = require('minimist')(process.argv.slice(2));
var crypto = require('crypto');
var dayjs = require('../lib/util/date');

var models = require('../lib/model/db');

var adminEmail = String(argv.email || 'demo-admin@example.local').trim().toLowerCase();
var companyName = String(argv.company || 'Демо компания').trim();
var countryCode = String(argv.country || 'RU').trim().toUpperCase();
var password = argv.password ? String(argv.password) : crypto.randomBytes(9).toString('base64url');
var generatedPassword = !argv.password;

var DEPARTMENTS = ['ИТ', 'Бухгалтерия', 'Маркетинг'];

var EMPLOYEES = [
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
  var map = {
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',
    м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',
    ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',ё:'e',
  };
  return value.toLowerCase().split('').map(function(char) {
    return map.hasOwnProperty(char) ? map[char] : char;
  }).join('');
}

async function seed() {
  await models.connect();

  var existing = await models.User.find_by_email(adminEmail);
  if (existing) {
    throw new Error(
      'Demo admin ' + adminEmail + ' already exists. '
      + 'Pass a different --email or remove the previous demo company first.'
    );
  }

  var admin = await models.User.register_new_admin_user({
    email        : adminEmail,
    password     : password,
    name         : 'Демо',
    lastname     : 'Администратор',
    company_name : companyName,
    country_code : countryCode,
    activated    : true,
  });

  var company = await models.Company.findOne({where: {id: admin.companyId}});
  var leaveTypes = await models.LeaveType.findAll({where: {companyId: company.id}});
  var mainLeaveType = leaveTypes[0];
  var altLeaveType = leaveTypes[1] || leaveTypes[0];

  var firstDepartment = await models.Department.findOne({where: {companyId: company.id}});
  var departments = [firstDepartment];

  for (var i = 0; i < DEPARTMENTS.length; i++) {
    departments.push(await models.Department.create({
      name      : DEPARTMENTS[i],
      companyId : company.id,
      allowance : firstDepartment.allowance,
      bossId    : admin.id,
    }));
  }

  var emailDomain = adminEmail.split('@')[1];
  var users = [];

  for (var j = 0; j < EMPLOYEES.length; j++) {
    var person = EMPLOYEES[j];
    var department = departments[j % departments.length];
    var user = await models.User.create({
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

  var today = dayjs.utc().startOf('day');
  var leavesCreated = 0;

  async function createLeave(user, startOffsetDays, lengthDays, status, leaveType) {
    var start = today.clone().add(startOffsetDays, 'days');
    var end = start.clone().add(lengthDays - 1, 'days');

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

  for (var k = 0; k < users.length; k++) {
    var employee = users[k];

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
    console.log('');
    console.log('Demo data created.');
    console.log('  Company    : ' + summary.company);
    console.log('  Departments: ' + summary.departments);
    console.log('  Employees  : ' + summary.users + ' (+1 admin)');
    console.log('  Leaves     : ' + summary.leaves);
    console.log('');
    console.log('Sign in at /login/ as ' + summary.admin);
    if (generatedPassword) {
      console.log('Password (shown once): ' + password);
    }
    console.log('All demo employees share the same password.');
    return models.sequelize.close();
  })
  .catch(function(error) {
    console.error('Failed to seed demo data: ' + (error && error.stack || error));
    return models.sequelize.close()
      .catch(function() {})
      .then(function() {
        process.exit(1);
      });
  });
