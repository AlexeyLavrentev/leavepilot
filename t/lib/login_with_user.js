const setViewport = require('./set_viewport');

'use strict';

var By        = require('selenium-webdriver').By,
    expect    = require('chai').expect,
    until     = require('selenium-webdriver').until,
    build_driver = require('./build_driver');


function login_with_user_func(args) {

  var application_host = args.application_host,
      user_email       = args.user_email,
      password         = args.password || '123456',
      should_fail      = args.should_fail || false,
      driver           = args.driver || build_driver();

  return setViewport(driver, {width: 1024, height: 768})
    .then(function() {
      return driver.get(application_host + 'login/');
    })
    .then(function() {
      return driver.wait(until.elementLocated(By.css('#local_login_form')), 5000);
    })
    .then(function() {
      return driver.findElement(By.css('h1'));
    })
    .then(function(el) {
      return el.getText();
    })
    .then(function(text) {
      expect(text).to.be.equal('Login');
    })
    .then(function() {
      return [
        {
          selector : '#local_login_form input[name="email"]',
          value    : user_email,
        },
        {
          selector : '#local_login_form input[name="password"]',
          value    : password,
        },
      ].reduce(function(p, test_case) {
        return p.then(function() {
          return driver
            .findElement(By.css(test_case.selector))
            .then(function(el) {
              return el.clear()
              .then(function() {
                return el.sendKeys(test_case.value);
              });
          });
      });
    })
    .then(function() {
      return driver.findElement(By.css('#local_login_form #submit_login'));
    })
    .then(function(el) {
      return el.click();
    })
    .then(function() {
      if (should_fail) {
        return driver
          .wait(until.elementLocated(By.css('div.alert-danger')), 1000)
          .then(function(el) {
            return el.getText();
          })
          .then(function(text) {
            expect(text).to.match(/Incorrect credentials/);
          });
      }

      return driver
        .wait(until.elementLocated(By.css('div.alert-success')), 1000)
        .then(function() {
          return driver.getTitle();
        })
        .then(function(title) {
          expect(title).to.match(/Calendar/);
        })
        .then(function() {
          return driver.findElement(By.css('div.alert-success'));
        })
        .then(function(el) {
          return el.getText();
        })
        .then(function(text) {
          expect(text).to.match(/Welcome back/);
        });
    })
    .then(function() {
      // "export" current driver
      return {
        driver : driver,
      };
    });
}

module.exports = function(args){
  return login_with_user_func(args);
}
