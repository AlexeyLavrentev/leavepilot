
'use strict';

var By               = require('selenium-webdriver').By,
    expect           = require('chai').expect,
    _                = require('underscore'),
    dayjs = require('../../../lib/util/date'),
    config                 = require('../../lib/config'),
    application_host       = config.get_application_host(),
    login_user_func        = require('../../lib/login_with_user'),
    register_new_user_func = require('../../lib/register_new_user'),
    logout_user_func       = require('../../lib/logout_user'),
    open_page_func         = require('../../lib/open_page'),
    submit_form_func       = require('../../lib/submit_form'),
    check_elements_func    = require('../../lib/check_elements'),
    check_booking_func     = require('../../lib/check_booking_on_calendar'),
    add_new_user_func      = require('../../lib/add_new_user');

/*
 *  Scenario to go in this test:
 *    - Create new company with admin user
 *    - Create new user
 *    - Login as new user
 *    - Submit leave request for new user (that incudes one end to be half)
 *    - Make sure that leve request is shown as a pending one for non admin user
 *    - Submit another leave request that overlaps with previous one,
 *      make sure it failed, cover following cases:
 *      - new request overlap with half by the full end
 *      - new request overlap with full by the half end
 *      - new request overlap with half by the half end
 *
 *   - Successfully submit new request that fits with fist one by the halfs ends
 *
 * */

describe('Overlapping leaverequest (with halfs)', function(){

  this.timeout( config.get_execution_timeout() );

  var non_admin_user_email, new_user_email, driver;

  var open_book_leave_modal = function(drv) {
    return submit_form_func._waitForModalClosed(drv, '#book_leave_modal')
      .then(function(){ return drv.findElement(By.css('#book_time_off_btn')); })
      .then(function(el){ return el.click(); })
      .then(function() {
        return drv.wait(function(){
          return drv.findElements(By.css('#book_leave_modal.in'))
            .then(function(els){
              if (!els.length) {
                return false;
              }

              return els[0].findElements(By.css('select[name="from_date_part"]'))
                .then(function(controls){
                  if (!controls.length) {
                    return false;
                  }

                  return Promise.all([controls[0].isDisplayed(), controls[0].isEnabled()])
                    .then(function(states){ return states[0] && states[1]; });
                });
            });
        }, 1500);
      });
  };

  var close_rejected_book_leave_modal = function(drv) {
    return drv.findElements(By.css('#book_leave_modal.in'))
      .then(function(modals){
        if (!modals.length) {
          return null;
        }

        return modals[0].isDisplayed()
          .then(function(visible){
            if (!visible) {
              return null;
            }

            return modals[0].findElement(By.css('[data-dismiss="modal"]'))
              .then(function(closeControl){
                return Promise.all([closeControl.isDisplayed(), closeControl.isEnabled()])
                  .then(function(states){
                    expect(states[0] && states[1], 'Expected the visible leave modal close control to be usable')
                      .to.equal(true);
                    return closeControl.click();
                  });
              });
          });
      })
      .then(function(){ return submit_form_func._waitForModalClosed(drv, '#book_leave_modal'); });
  };

  var check_no_booking = function(day) {
    return Promise.all(['half_1st', 'half_2nd'].map(function(half){
      var selector = 'table.month_' + day.format('MMMM') + ' td.day_' + day.format('D') + '.' + half;
      return driver.findElement(By.css(selector))
        .then(function(el){ return el.getAttribute('class'); })
        .then(function(css){ expect(css).not.to.match(/\bleave_cell(?:_pended)?\b/); });
    }));
  };

  var check_original_booking_only = function(rejected_days) {
    return check_booking_func({
      driver         : driver,
      full_days      : [dayjs.utc('2015-06-17')],
      halfs_1st_days : [dayjs.utc('2015-06-16')],
      type           : 'pended',
    }).then(function(){
      return Promise.all(rejected_days.map(check_no_booking));
    });
  };

  it('Create new company', function(done){
    register_new_user_func({
      application_host : application_host,
    })
    .then(function(data){
      driver = data.driver;
      new_user_email = data.email;
      done();
    })
    .catch(done);
  });

  it("Create new non-admin user", function(done){
    add_new_user_func({
      application_host : application_host,
      driver           : driver,
    })
    .then(function(data){
      non_admin_user_email = data.new_user_email;
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

  it("Login as non-admin user", function(done){
    login_user_func({
      application_host : application_host,
      user_email       : non_admin_user_email,
      driver           : driver,
    })
    .then(function(){ done() })
    .catch(done);
  });

  it("Open calendar page", function(done){
    open_page_func({
      url    : application_host + 'calendar/?show_full_year=1&year=2015',
      driver : driver,
    })
    .then(function(){ done() })
    .catch(done);
  });

  it("And make sure that it is calendar indeed", function(done){
    driver
      .getTitle()
      .then(function(title){
        expect(title).to.be.equal('Calendar');
        done();
      })
      .catch(done);
  });

  it("Request new leave", function(done){
    driver
      .then(function(){ return open_book_leave_modal(driver) })

      // Create new leave request
      .then(function(){

        submit_form_func({
          driver      : driver,
          form_params : [{
            selector        : 'select[name="from_date_part"]',
            option_selector : 'option[value="2"]',
            value           : "2",
          },{
            selector : 'input#from',
            value : '2015-06-16',
          },{
            selector : 'input#to',
            value : '2015-06-17',
          }],
          message : /New leave request was added/,
        })
        .then(function(){
          return check_original_booking_only([dayjs.utc('2015-06-15')]);
        })
        .then(function(){ done() })
        .catch(done);
      })
        .catch(done);
  });

  it("Check that all days are marked as pended", function(done){
    check_booking_func({
      driver         : driver,
      full_days      : [dayjs.utc('2015-06-17')],
      halfs_1st_days : [dayjs.utc('2015-06-16')],
      type           : 'pended',
    })
    .then(function(){ done() })
    .catch(done);
  });

  it("Try to request overlapping leave request (new request overlaps with half by the full end)", function(done){
    driver
      .then(function(){ return open_book_leave_modal(driver) })

      // Create new leave request
      .then(function(){

        submit_form_func({
          driver      : driver,
          form_params : [{
            selector : 'input#from',
            value : '2015-06-15',
          },{
            selector : 'input#to',
            value : '2015-06-16',
          }],
          message           : /Failed to create a leave request/,
        })
        .then(function(){
          return check_original_booking_only([dayjs.utc('2015-06-15')]);
        })
        .then(function(){ return close_rejected_book_leave_modal(driver); })
        .then(function(){ done() })
        .catch(done);
      })
        .catch(done);
  });

  it("Try to create new request that overlaps with existing one: new request's " +
    "half end colides with full part of existing one", function(done){
    driver
      .then(function(){ return open_book_leave_modal(driver) })

      // Create new leave request
      .then(function(){

        submit_form_func({
          driver      : driver,
          form_params : [{
            selector        : 'select[name="from_date_part"]',
            option_selector : 'option[value="2"]',
            value           : "2",
          },{
            selector : 'input#from',
            value : '2015-06-17',
          },{
            selector : 'input#to',
            value : '2015-06-18',
          }],
          message           : /Failed to create a leave request/,
        })
        .then(function(){
          return check_original_booking_only([dayjs.utc('2015-06-18')]);
        })
        .then(function(){
          return check_original_booking_only([dayjs.utc('2015-06-15')]);
        })
        .then(function(){ return close_rejected_book_leave_modal(driver); })
        .then(function(){ done() })
        .catch(done);
      });
  });

  it("Try to create new leave request that colides with existing by halfs", function(done){
    driver
      .then(function(){ return open_book_leave_modal(driver) })

      // Create new leave request
      .then(function(){

        submit_form_func({
          driver      : driver,
          form_params : [{
            selector        : 'select[name="to_date_part"]',
            option_selector : 'option[value="2"]',
            value           : "2",
          },{
            selector : 'input#from',
            value : '2015-06-15',
          },{
            selector : 'input#to',
            value : '2015-06-16',
          }],
          message           : /Failed to create a leave request/,
        })
        .then(function(){
          return check_original_booking_only([dayjs.utc('2015-06-15')]);
        })
        .then(function(){ return close_rejected_book_leave_modal(driver); })
        .then(function(){ done() })
        .catch(done);
      })
        .catch(done);
  });

  it("And create correct one", function(done){
    driver
      .then(function(){ return open_book_leave_modal(driver) })

      // Create new leave request
      .then(function(){

        submit_form_func({
          driver      : driver,
          form_params : [{
              selector        : 'select[name="to_date_part"]',
              option_selector : 'option[value="3"]',
              value           : "3",
          },{
              selector : 'input#from',
              value : '2015-06-15',
          },{
              selector : 'input#to',
              value : '2015-06-16',
          }],
          message           : /New leave request was added/,
          expect_navigation : true,
          modal_selector    : '#book_leave_modal',
        })
        .then(function(){ done() })
        .catch(done);
      })
        .catch(done);
  });

  it("Check that all days are marked as pended", function(done){
    check_booking_func({
      driver    : driver,
      full_days : [dayjs.utc('2015-06-15'),dayjs.utc('2015-06-16'),dayjs.utc('2015-06-17')],
      type      : 'pended',
    })
    .then(function(){ done() })
    .catch(done);
  });

  after(function(done){
    driver.quit().then(function(){ done(); });
  });

});
