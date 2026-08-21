
'use strict';

var register_new_user_func = require('../lib/register_new_user'),
  login_user_func        = require('../lib/login_with_user'),
  add_new_user_func      = require('../lib/add_new_user'),
  By                     = require('selenium-webdriver').By,
  expect                 = require('chai').expect,
  _                      = require('underscore'),
  logout_user_func       = require('../lib/logout_user'),
  config                 = require('../lib/config'),
  application_host       = config.get_application_host();

/*
 *  Scenario to check in thus test.
 *
 *  * Create new account
 *  * Login into system
 *  * Check that all admin links are available on the menu bar
 *  * Create non admin user
 *  * Login with non-admin user
 *  * Make sure that only limited set of links are available
 *  * Admon features are not available
 *
 * */

describe('Menu bar reflect permissions of logged in user', function(){

  this.timeout( config.get_execution_timeout() );

  var ordinary_user_email, driver;

  it('Create new company', function(done){
    register_new_user_func({
      application_host : application_host,
    })
    .then(function(data){
      driver = data.driver;
      done();
    })
    .catch(done);
  });

  it("Check that all necessary menus are shown", function(done){
    var promises_to_check =  check_presense_promises({
      driver    : driver,
      presense  : true,
      selectors : [
        'li > a[href="/calendar/"]',
        'li > a[href="/calendar/teamview/"]',
        'li > a[href="/calendar/feeds/"]',
        'li > a[href="/users/"]',
        'li > a[href="/settings/general/"]',
        'li > a[href="/settings/departments/"]',
        'li > a[href="/requests/"]',
        'li > a[href="/logout/"]',
      ],
    });

    Promise
      .all( promises_to_check )
      .then(function(){ done() })
      .catch(done);
  });

  it("Create non-admin user", function(done){
    add_new_user_func({
      application_host : application_host,
      driver           : driver,
    })
    .then(function(data){
      ordinary_user_email = data.new_user_email;
      done();
    })
    .catch(done);
  });

  it("Logout from admin acount", function(done){
    logout_user_func({
      application_host : application_host,
      driver           : driver,
    })
    .then(function(){ done() })
    .catch(done);
  });

  it("Login as ordinary user", function(done){
    login_user_func({
      application_host : application_host,
      user_email       : ordinary_user_email,
      driver           : driver,
    })
    .then(function(){ done() })
    .catch(done);
  });

  it("Check that limited links are there", function(done){
    var promises_to_check =  check_presense_promises({
      driver    : driver,
      presense  : true,
      selectors : [
        'li > a[href="/calendar/"]',
        'li > a[href="/calendar/teamview/"]',
        'li > a[href="/calendar/feeds/"]',
        'li > a[href="/requests/"]',
        'li > a[href="/logout/"]',
      ],
    });

    Promise
      .all( promises_to_check)
      .then( function(){ done() });
  });

  it("Check that admin links are not shown", function(done){
    var promises_to_check =  check_presense_promises({
      driver    : driver,
      presense  : false,
      selectors : [
        'li > a[href="/users/"]',
        'li > a[href="/settings/general/"]',
        'li > a[href="/settings/departments/"]',
      ],
    });

    Promise
      .all( promises_to_check)
      .then( function(){ done() });
  });

  after(function(done){
    driver.quit().then(function(){ done(); });
  });

});

function check_presense_promises(args){

  var selectors = args.selectors,
      driver    = args.driver,
      presense  = args.presense || false;

  var promises_to_check = _.map(
   selectors,
    function( selector ){
      return driver
        .findElements(By.css(selector))
        .then(function(elements){
          expect(elements.length > 0).to.be.equal(presense);
          return Promise.resolve();
        })
    }
  );

  return promises_to_check;
};
