'use strict';

var expect = require('chai').expect;
var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');

describe('Edition community boundary', function() {
  var repoRoot = path.join(__dirname, '..', '..');
  var premiumIdentifiers = [
    // Time Balance
    'timeBalance',
    'vacationPlans',
    'time_balance',
    'vacation_planning',
    'time-balance',
    'vacation-plans',
    'TimeBalanceEntry',
    'VacationPlan',
    'pendingTimeBalanceRequest',
    'pendingVacationPlan',
  ];
  var scannedPaths = [
    'app.js',
    'lib',
    'views',
    path.join('public', 'js'),
    path.join('public', 'css'),
    'scss',
    path.join('public', 'locales'),
    'migrations',
  ];

  function runNode(script, env) {
    return childProcess.execFileSync(process.execPath, ['-e', script], {
      cwd: repoRoot,
      env: Object.assign({}, process.env, env || {}),
      encoding: 'utf8',
    }).trim();
  }

  function scanFile(filePath, matches) {
    var contents = fs.readFileSync(filePath, 'utf8');
    premiumIdentifiers.forEach(function(identifier) {
      if (contents.indexOf(identifier) !== -1) {
        matches.push(path.relative(repoRoot, filePath) + ': ' + identifier);
      }
    });
  }

  function scanPath(filePath, matches) {
    if (!fs.existsSync(filePath)) {
      return;
    }

    var stats = fs.statSync(filePath);

    if (stats.isDirectory()) {
      fs.readdirSync(filePath).forEach(function(childName) {
        scanPath(path.join(filePath, childName), matches);
      });
      return;
    }

    if (stats.isFile()) {
      scanFile(filePath, matches);
    }
  }

  it('keeps premium identifiers out of community source surfaces', function() {
    var matches = [];

    scannedPaths.forEach(function(scannedPath) {
      scanPath(path.join(repoRoot, scannedPath), matches);
    });

    expect(matches).to.deep.equal([]);
  });

  it('does not load bundled premium DB models in community mode', function() {
    var output = runNode([
      "delete process.env.TIMEOFF_PREMIUM_MODULE;",
      "const app=require('./app');",
      "const db=app.get('db_model');",
      "const i18next=require('./lib/i18n').i18next;",
      "console.log(Boolean(db.TimeBalanceEntry) + ',' + Boolean(db.VacationPlan) + ',' + i18next.t('nav.timeBalance'));",
      "process.exit(0);",
    ].join(''));

    expect(output).to.equal('false,false,nav.timeBalance');
  });

  it('registers only community routes in the community edition registry', function() {
    var output = runNode([
      "delete process.env.TIMEOFF_PREMIUM_MODULE;",
      "const edition = require('./lib/edition');",
      "edition.initialize({});",
      "const routes = edition.getRegistry().getRoutes().map(r => r.name);",
      "console.log(JSON.stringify(routes));",
      "process.exit(0);",
    ].join(''));

    expect(JSON.parse(output)).to.deep.equal([
      'reminder-schedules-settings',
      'reminder-schedules-api',
    ]);
  });

  it('registers only community schedulers in the community edition registry', function() {
    var output = runNode([
      "delete process.env.TIMEOFF_PREMIUM_MODULE;",
      "const edition = require('./lib/edition');",
      "edition.initialize({});",
      "const schedulers = edition.getRegistry().getSchedulers().map(s => s.name);",
      "console.log(JSON.stringify(schedulers));",
      "process.exit(0);",
    ].join(''));

    expect(JSON.parse(output)).to.deep.equal(['leave-start-reminders', 'delivery-outbox']);
  });

  it('uses the SSO stub (SSO disabled) in community mode', function() {
    var output = runNode([
      "delete process.env.TIMEOFF_PREMIUM_MODULE;",
      "const edition = require('./lib/edition');",
      "edition.initialize({});",
      "const sso = edition.getRegistry().getSsoProvider();",
      "console.log(sso !== null && sso.isSsoEnabled());",
      "process.exit(0);",
    ].join(''));

    expect(output).to.equal('false');
  });

});
