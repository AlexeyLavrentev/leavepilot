
/*
 * Exports function that checks if given emails of users are shown
 * on the Teamview page. And if so how they are rendered: as text or link.
 *
 * It does not check exact emails, just count numbers.
 *
 * */

'use strict';

const { promisify } = require('util');
var
  By             = require('selenium-webdriver').By,
  expect         = require('chai').expect,
  open_page_func = require('./open_page'),
  config         = require('./config');
module.exports = promisify( function(args, callback){

  var
    result_callback = callback,
    driver          = args.driver,
    emails          = args.emails || [],
    is_link         = args.is_link || false,
    application_host = args.application_host || config.get_application_host();

  if ( ! driver ) {
    throw "'driver' was not passed into the teamview_check_user!";
  }

  return open_page_func({
    url    : application_host + 'calendar/teamview/',
    driver : driver,
  })

  .then(function(data){
    // After Stage 5 the employee name lives inside .team-view-employee-cell.
    // Admin sees .team-view-employee-link (real /users/edit/ anchors);
    // non-admin sees .team-view-employee-name (plain spans).
    var selector = is_link
      ? 'tr.teamview-user-list-row td.cross-link .team-view-employee-link'
      : 'tr.teamview-user-list-row td.cross-link .team-view-employee-name';

    var oppositeSelector = is_link
      ? 'tr.teamview-user-list-row td.cross-link .team-view-employee-name'
      : 'tr.teamview-user-list-row td.cross-link .team-view-employee-link';

    return data.driver
      .findElements(By.css(selector))
      .then(function(elements){
        expect(elements.length).to.be.equal(emails.length);
        return data.driver.findElements(By.css(oppositeSelector));
      })
      .then(function(opposite){
        expect(opposite.length, 'opposite name type must not be present').to.be.equal(0);
        return Promise.resolve(data);
      });
  })

  .then(function(data){
    // "export" current driver
    result_callback(
      null,
      {
        driver : data.driver,
      }
    );
  });

});

