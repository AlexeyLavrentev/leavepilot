
'use strict';

var until            = require('selenium-webdriver').until,
    By               = require('selenium-webdriver').By,
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
    add_new_user_func      = require('../../lib/add_new_user');


describe('Ensure that leaves with not full days are rendered properly', function(){

  this.timeout( config.get_execution_timeout() );

  var non_admin_user_email, new_user_email, driver;

  function open_book_leave_modal() {
    return submit_form_func._waitForModalClosed(driver, '#book_leave_modal')
      .then(() => driver.findElement(By.css('#book_time_off_btn')))
      .then(el => el.click())
      .then(() => driver.wait(() => (
        driver.findElements(By.css('#book_leave_modal.in')).then(els => {
          if (!els.length) {
            return false;
          }

          return els[0].findElements(By.css('select[name="from_date_part"]'))
            .then(controls => {
              if (!controls.length) {
                return false;
              }

              return Promise.all([controls[0].isDisplayed(), controls[0].isEnabled()])
                .then(([visible, enabled]) => visible && enabled);
            });
        })
      ), 10000));
  }

  it('Create new company', done => {
    register_new_user_func({
      application_host : application_host,
    })
    .then(data => {
      driver = data.driver;
      new_user_email = data.email;
      done();
    })
    .catch(done);
  });

  it("Create new non-admin user", done => {
    add_new_user_func({
      application_host : application_host,
      driver           : driver,
    })
    .then(data =>{
      non_admin_user_email = data.new_user_email;
      done();
    })
    .catch(done);
  });

  it("Logout from admin acount", done => {
    logout_user_func({
      application_host : application_host,
      driver           : driver,
    })
    .then(() => done());
  });

  it("Login as non-admin user", done => {
    login_user_func({
      application_host : application_host,
      user_email       : non_admin_user_email,
      driver           : driver,
    })
    .then(() => done());
  });

  it("Open calendar page", done =>{
    open_page_func({
      url    : application_host + 'calendar/?show_full_year=1&year=2015',
      driver : driver,
    })
    .then(() => done());
  });

  it("Request new partial leave: morning to afternoon", done => {
    open_book_leave_modal()
      // Create new leave request
      .then(() => submit_form_func({
          driver      : driver,
          modal_selector : '#book_leave_modal',
          submit_button_selector : '#book_leave_modal button[type="submit"]',
          form_params : [{
            selector        : 'select[name="from_date_part"]',
            option_selector : 'option[value="2"]',
            value           : "2",
          },{
            selector : 'input#from',
            value : '2015-06-16',
          },{
            selector        : 'select[name="to_date_part"]',
            option_selector : 'option[value="3"]',
            value           : "3",
          },{
            selector : 'input#to',
            value : '2015-06-17',
          }],
          message : /New leave request was added/,
        })
      )
      .then(() => done())
      .catch(done);
  });

  it("Request new partial leave: afternoon to morning", done => {
    open_book_leave_modal()
      // Create new leave request
      .then(() => submit_form_func({
          driver      : driver,
          modal_selector : '#book_leave_modal',
          submit_button_selector : '#book_leave_modal button[type="submit"]',
          form_params : [{
            selector        : 'select[name="from_date_part"]',
            option_selector : 'option[value="3"]',
            value           : "3",
          },{
            selector : 'input#from',
            value : '2015-06-23',
          },{
            selector        : 'select[name="to_date_part"]',
            option_selector : 'option[value="2"]',
            value           : "2",
          },{
            selector : 'input#to',
            value : '2015-06-24',
          }],
          message : /New leave request was added/,
        })
      )
      .then(() => done())
      .catch(done);
  });


  it("Request just morning", done => {
    open_book_leave_modal()
      // Create new leave request
      .then(() => submit_form_func({
          driver      : driver,
          modal_selector : '#book_leave_modal',
          submit_button_selector : '#book_leave_modal button[type="submit"]',
          form_params : [{
            selector        : 'select[name="from_date_part"]',
            option_selector : 'option[value="2"]',
            value           : "2",
          },{
            selector : 'input#from',
            value : '2015-06-09',
          },{
            selector        : 'select[name="to_date_part"]',
            option_selector : 'option[value="1"]',
            value           : "1",
          },{
            selector : 'input#to',
            value : '2015-06-09',
          }],
          message : /New leave request was added/,
        })
      )
      .then(() => done())
      .catch(done);
  });

  it("Request just multi days leave starting next afternoon", done => {
    open_book_leave_modal()
      // Create new leave request
      .then(() => submit_form_func({
          driver      : driver,
          modal_selector : '#book_leave_modal',
          submit_button_selector : '#book_leave_modal button[type="submit"]',
          form_params : [{
            selector        : 'select[name="from_date_part"]',
            option_selector : 'option[value="3"]',
            value           : "3",
          },{
            selector : 'input#from',
            value : '2015-06-09',
          },{
            selector        : 'select[name="to_date_part"]',
            option_selector : 'option[value="1"]',
            value           : "1",
          },{
            selector : 'input#to',
            value : '2015-06-11',
          },{
            selector : 'select[name="leave_type"]',
            option_selector : 'option[data-tom-index="1"]',
          }],
          message : /New leave request was added/,
        })
      )
      .then(() => done())
      .catch(done);
  });

  it("Go to my requests page", done => {
    open_page_func({
      url    : application_host + 'requests/',
      driver : driver,
    })
    .then(() => done());
  });

  it("Ensure that both new leave requests are listed and both are marked as partial", done => {
    driver
      .findElements(By.css('table.user-requests-table td[data-tom-leave-dates="1"]'))
      .then(els => {
        expect(els.length, 'Ensure two elements with leave dates were found').to.be.equal(4);
        return Promise.all(els.map(el => el.getText()));
      })
      .then(dates_str => {
        expect(dates_str.sort(), 'Ensure that date ranges values are as expected')
          .to.be.deep.equal([
            'Leave summary:\n2015-06-09 (Afternoon) 2015-06-11',
            'Leave summary:\n2015-06-09 (Morning) 2015-06-09',
            'Leave summary:\n2015-06-16 (Morning) 2015-06-17 (Afternoon)',
            'Leave summary:\n2015-06-23 (Afternoon) 2015-06-24 (Morning)'
          ]);
        done();
      })
      .catch(done);
  });

  it('Ensure tooltips include leave type name', done => {
    open_page_func({
      url    : application_host + 'calendar/?show_full_year=1&year=2015',
      driver,
    })
    .then(() => Promise.all(
      [9, 10, 11, 16, 17, 23, 24].map(day => driver.findElement(By.css(`.month_June td.half_1st.day_${day} .calendar-leave-details-trigger`)).then(el => el.getAttribute('data-original-title')))
    ))
    .then(([title9, title10, title11, title16, title17, title23, title24]) => {
      expect(title9).to.contain('Holiday (morning) Sick Leave (afternoon)');
      expect(title10).to.contain('Sick Leave');
      expect(title11).to.contain('Sick Leave');
      expect(title16).to.contain('Holiday (morning)');
      expect(title17).to.contain('Holiday (afternoon)');
      expect(title23).to.contain('Holiday (afternoon)');
      expect(title24).to.contain('Holiday (morning)');
      return Promise.resolve(1);
    })
    .then(function(){ done() })
    .catch(done);
  });

  it("Logout from non-admin account", done => {
    logout_user_func({
      application_host : application_host,
      driver           : driver,
    })
    .then(() => done());
  });

  it("Login as admin user", done => {
    login_user_func({
      application_host : application_host,
      user_email       : new_user_email,
      driver           : driver,
    })
    .then(() => done());
  });

  it("Go to my requests page", done => {
    open_page_func({
      url    : application_host + 'requests/',
      driver : driver,
    })
    .then(() => done());
  });

  it("Ensure that both new leave requests are listed for approval and both are marked as partial", done => {
    driver
      .findElements(By.css('table.requests-to-approve-table td[data-tom-leave-dates="1"]'))
      .then(els => {
        expect(els.length, 'Ensure two elements with leave dates were found').to.be.equal(4);
        return Promise.all(els.map(el => el.getText()));
      })
      .then(dates_str => {
        expect(dates_str.sort(), 'Ensure that date ranges values are as expected')
          .to.be.deep.equal([
            'Leave summary:\n2015-06-09 (Afternoon) 2015-06-11',
            'Leave summary:\n2015-06-09 (Morning) 2015-06-09',
            'Leave summary:\n2015-06-16 (Morning) 2015-06-17 (Afternoon)',
            'Leave summary:\n2015-06-23 (Afternoon) 2015-06-24 (Morning)'
          ]);
        done();
      })
      .catch(done);
  });

  after(done => {
    driver.quit().then(() => done());
  });

});
