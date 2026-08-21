
'use strict';

var By        = require('selenium-webdriver').By,
    expect    = require('chai').expect,
    _         = require('underscore'),
    until     = require('selenium-webdriver').until,
    submit_form_func = require('./submit_form'),
    build_driver     = require('./build_driver'),
    add_new_user_form_id = '#add_new_user_form',
    driver;

module.exports = function(args){
  var application_host = args.application_host,
      department_index  = args.department_index,
      // optional parameter, if provided the user adding action is expected to fail
      // with that error
      error_message = args.error_message,

  driver = args.driver || build_driver();

  var random_token =  (new Date()).getTime();
  var new_user_email = args.email || random_token + '@test.com';

  var form_params = [{
      selector : add_new_user_form_id+' input[name="name"]',
      value    : 'name'+random_token,
  },{
      selector : add_new_user_form_id+' input[name="lastname"]',
      value    : 'lastname'+random_token,
  },{
      selector : add_new_user_form_id+' input[name="email_address"]',
      value    : new_user_email,
  },{
      selector : add_new_user_form_id+' input[name="password_one"]',
      value    : '123456',
  },{
      selector : add_new_user_form_id+' input[name="password_confirm"]',
      value    : '123456',
  }];

  if (typeof department_index !== 'undefined') {
    form_params.push({
      selector        : 'select[name="department"]',
      option_selector : 'option[data-vpp="'+department_index+'"]',
    });
  }

  form_params.push({
    selector : add_new_user_form_id+' input[name="start_date"]',
    value : '2015-06-01',
  });

  return driver
    .get(application_host  + 'users/add/')
    .then(function(){
      return submit_form_func({
        driver      : driver,
        form_params : form_params,
        submit_button_selector : add_new_user_form_id+' #add_new_user_btn',
        should_be_successful : error_message ? false : true,
        elements_to_check : [],
        message : error_message ?
          new RegExp(error_message) :
          /New user account successfully added/,
      });
    })
    .then(function(){
      return {
        driver         : driver,
        new_user_email : new_user_email,
      };
    });
};
