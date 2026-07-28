
'use strict';

const
    By               = require('selenium-webdriver').By,
    until            = require('selenium-webdriver').until,
    expect           = require('chai').expect,
    _                = require('underscore'),
    Promise          = require("bluebird"),
    moment           = require('moment'),
    login_user_func        = require('../../lib/login_with_user'),
    register_new_user_func = require('../../lib/register_new_user'),
    open_page_func         = require('../../lib/open_page'),
    submit_form_func       = require('../../lib/submit_form'),
    check_elements_func    = require('../../lib/check_elements'),
    check_booking_func     = require('../../lib/check_booking_on_calendar'),
  leave_type_edit_form_id='#leave_type_edit_form',
  leave_type_new_form_id ='#leave_type_new_form',
  config                 = require('../../lib/config'),
  application_host       = config.get_application_host(),
  userStartsAtTheBeginingOfYear = require('../../lib/set_user_to_start_at_the_beginning_of_the_year');

/*
 *  Scenario to go in this test:
 *    - Create new company with admin user
 *    - Create new leave type (one tath is always at the start of list, e.g. AAA)
 *    - Create pended leave for that type
 *    - Try to remove the type
 *    - Ensure system prevent of doing this
 *
 * */

describe('Try to remove used leave type', function(){

  this.timeout( config.get_execution_timeout() );

  var driver, email;

  it('Create new company', function(done){
    register_new_user_func({
      application_host : application_host,
    })
    .then(function(data){
      ({driver, email} = data);
      done();
    });
  });

  it("Ensure user starts at the very beginning of current year", done =>{
    userStartsAtTheBeginingOfYear({driver, email, year:2015})
      .then(() => done())
  });

  it("Open page with leave types", function(done){
    open_page_func({
      url    : application_host + 'settings/general/',
      driver : driver,
    })
    .then(function(){ done() });
  });

  it("Add new leave type", function(){
    var old_body;
    return driver
      .findElement(By.css('#add_new_leave_type_btn'))
      .then(function(el){ return el.click() })
      .then(function(){
        return driver.wait(
          until.elementLocated(By.css('#add_new_leave_type_modal.in')),
          5000
        );
      })
      .then(function(){
        return driver.findElement(By.css('body'));
      })
      .then(function(body){
        old_body = body;
        return driver.executeScript(
          'var form = document.querySelector(arguments[0]);'
          + 'form.querySelector(\'input[name="name__new"]\').value = "AAAAA";'
          + 'form.querySelector(\'input[name="use_allowance__new"]\').checked = true;'
          + 'form.requestSubmit();',
          leave_type_new_form_id
        );
      })
      .then(function(){
        return driver.wait(until.stalenessOf(old_body), 30000);
      })
      .then(function(){
        return driver.wait(function(){
          return driver
            .findElements(By.css(leave_type_edit_form_id+' input[name^="name__"]'))
            .then(function(elements){
              return Promise.all(elements.map(function(element){
                return element.getAttribute('value');
              }));
            })
            .then(function(names){
              return names.indexOf('AAAAA') !== -1;
            })
            .catch(function(){
              return false;
            });
        }, 30000);
      });
  });

  it("Open calendar page", function(done){
    open_page_func({
      url    : application_host + 'calendar/?show_full_year=1&year=2015',
      driver : driver,
    })
    .then(function(){ done() });
  });

  it("Request new leave", function(){
    return driver
      .findElement(By.css('#book_time_off_btn'))
      .then(function(el){ return el.click() })

      // Create new leave request
      .then(function(){
        return submit_form_func({
          driver      : driver,
          // The order matters here as we need to populate dropdown prior date filds
          form_params : [{
            selector        : 'select[name="from_date_part"]',
            option_selector : 'option[value="2"]',
          },{
            selector : 'select[name="leave_type"]',
            option_selector : 'option[data-tom-index="0"]',
          },{
            selector : 'input#from',
            value : '2015-06-15',
          },{
            selector : 'input#to',
            value : '2015-06-16',
          }],
          message : /New leave request was added/,
        });
      });
  });

  it("Check that all days are marked as pended", function(done){
    check_booking_func({
      driver         : driver,
      full_days      : [moment('2015-06-16')],
      halfs_1st_days : [moment('2015-06-15')],
      type           : 'pended',
    })
    .then(function(){ done() });
  });

  it("Open page with leave types", function(done){
    open_page_func({
      url    : application_host + 'settings/general/',
      driver : driver,
    })
    .then(function(){ done() });
  });

  it("Try to remove newly added leave type and ensure it fails", function(done){
    submit_form_func({
      driver : driver,
      submit_button_selector : leave_type_edit_form_id+' button[data-tom-leave-type-order="remove_0"]',
      message : /Cannot remove leave type: type is in use/,
      confirm_dialog : true,
    })
    .then(function(){ done() });
  });

  after(function(done){
    driver.quit().then(function(){ done(); });
  });

});
