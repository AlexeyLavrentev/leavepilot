const setViewport = require('./set_viewport');
const { promisify } = require('util');
/*

*/

'use strict';

var By        = require('selenium-webdriver').By,
    until     = require('selenium-webdriver').until,
    expect    = require('chai').expect,
    open_page_func       = require('./open_page'),
    build_driver         = require('./build_driver'),
    company_edit_form_id = '#company_edit_form',
    submit_form_func     = require('./submit_form');

function is_transient_session_error(error) {
  var message = error && (error.message || error.toString());

  return /invalid session id|browser has closed|disconnected/i.test(message || '');
}

var register_new_user_func = promisify( function(args, callback){

  var
    application_host      = args.application_host || args.applicationHost,
    failing_error_message = args.failing_error_message,
    default_date_format   = args.default_date_format,
    application_root      = application_host.replace(/\/+$/, ''),
    random_token          = (new Date()).getTime(),
    new_user_email        = args.user_email || random_token + '@test.com';

  // Instantiate new driver object if it not provided as paramater
  var driver = args.driver || build_driver()


  setViewport(driver, {width: 1024, height: 768})
    .then(function(){
      return driver.get(application_root + '/register/');
    })
    .then(function(){
      return driver.wait(until.elementLocated(By.css('h1')), 5000);
    })
    .then(function(){
      return driver.findElement(By.css('h1'));
    })
    .then(function(el){
      return el.getText();
    })
    .then(function(text){
      if (text !== 'New company') {
        return driver.getCurrentUrl()
          .then(function(url){
            expect(text, 'Expected registration page at ' + url).to.be.equal('New company');
          });
      }

      return Promise.resolve();
    })
    .then(function(){
      return submit_form_func({
        driver : driver,
        form_params : [{
          selector : 'input[name="company_name"]',
          value    : 'Company '+(new Date()).getTime(),
        },{
          selector : 'input[name="name"]',
          value    : 'name' + random_token,
        },{
          selector : 'input[name="lastname"]',
          value    : 'lastname' + random_token,
        },{
          selector : 'input[name="email"]',
          value    : new_user_email,
        },{
          selector : 'input[name="password"]',
          value    : '123456',
        },{
          selector : 'input[name="password_confirmed"]',
          value    : '123456',
        },{
          selector        : 'select[name="country"]',
          option_selector : 'option[value="ZZ"]',
        }],
        submit_button_selector : '#submit_registration',
        elements_to_check : [],
        message : failing_error_message
          ? new RegExp(failing_error_message)
          : /.*/,
        should_be_successful : !failing_error_message,
      });
    })
    .catch(function(error){
      if (failing_error_message) {
        throw error;
      }

      return driver.getTitle()
        .then(function(title){
          if (/Calendar/.test(title)) {
            return Promise.resolve();
          }

          throw error;
        });
    })
    .then(function(){
      if (failing_error_message) {
        return Promise.resolve();
      }

      return driver.wait(function(){
        return driver.getTitle().then(function(title){
          return /Calendar/.test(title);
        });
      }, 5000);
    })
    .then(function(){
      if (!default_date_format) {
        return Promise.resolve();
      }

      return open_page_func({
        url    : application_root + '/settings/general/',
        driver : driver,
      })
      .then(function(){
        return submit_form_func({
          driver      : driver,
          form_params : [{
            selector : company_edit_form_id+' select[name="date_format"]',
            option_selector : 'option[value="'+default_date_format+'"]',
            value    : default_date_format,
          }],
          elements_to_check : [],
          submit_button_selector : company_edit_form_id+' button[type="submit"]',
          should_be_successful : true,
        });
      })
      .then(function(){
        return driver.sleep(1000);
      });
    })
    .then(function(){
      if (default_date_format) {
        return Promise.resolve();
      }

      return driver.get(application_root + '/');
    })
    .then(function(){
      callback(null, {
        driver : driver,
        email : new_user_email,
      });
    })
    .catch(function(error){
      if (!args.driver && !args._retried_after_session_crash && !failing_error_message && is_transient_session_error(error)) {
        return driver.quit()
          .catch(function(){ return Promise.resolve(); })
          .then(function(){
            var retry_args = Object.assign({}, args, {
              _retried_after_session_crash : true,
            });

            return register_new_user_func(retry_args);
          })
          .then(function(data){
            callback(null, data);
          })
          .catch(function(retry_error){
            callback(retry_error);
          });
      }

      callback(error);
    });

});

module.exports = function(args){
  return register_new_user_func(args);
};
