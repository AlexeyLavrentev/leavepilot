'use strict';

var config           = require('../../lib/config'),
    application_host = config.get_application_host(),
    By               = require('selenium-webdriver').By,
    Key              = require('selenium-webdriver').Key,
    expect           = require('chai').expect,
    until            = require('selenium-webdriver').until,
    Promise          = require('bluebird'),
    register_new_user_func = require('../../lib/register_new_user'),
    open_page_func         = require('../../lib/open_page');

describe("Book leave modal keyboard focus management", function(){

  this.timeout( config.get_execution_timeout() );

  var driver;

  it("Register new company", function(done){
    register_new_user_func({
      application_host : application_host,
    })
    .then(function(data){
      driver = data.driver;
      done();
    })
    .catch(done);
  });

  it("Open calendar page", function(done){
    open_page_func({
      url    : application_host + 'calendar/',
      driver : driver,
    })
    .then(function(){ done() })
    .catch(done);
  });

  it("Places focus on the New absence opener button", function(done){
    driver
      .executeScript('document.getElementById("book_time_off_btn").focus()')
      .then(function(){
        return driver.executeScript('return document.activeElement.id');
      })
      .then(function(activeId){
        expect(activeId).to.equal('book_time_off_btn');
      })
      .then(function(){ done() })
      .catch(done);
  });

  it("Opens the modal via keyboard (Enter on the opener)", function(done){
    driver
      .switchTo().activeElement()
      .then(function(el){ return el.sendKeys(Key.ENTER); })
      .then(function(){
        return driver.wait(
          until.elementLocated(By.css('#book_leave_modal.in')),
          2000
        );
      })
      // let shown.bs.modal handlers run and focus settle
      .then(function(){ return driver.sleep(300); })
      .then(function(){ done() })
      .catch(done);
  });

  it("Moves focus to the first form control after shown.bs.modal", function(done){
    // A newly registered user has no supervised users, so #employee is absent
    // and the focus order resolves to #leave_type.
    driver
      .wait(function(){
        return driver.executeScript('return document.activeElement.id')
          .then(function(id){ return id === 'leave_type'; });
      }, 2000)
      .then(function(){ done() })
      .catch(done);
  });

  it("Closes the modal with Escape sent to the focused control", function(done){
    driver
      .switchTo().activeElement()
      .then(function(el){ return el.sendKeys(Key.ESCAPE); })
      .then(function(){ return driver.sleep(400); })
      .then(function(){
        return driver.wait(until.elementIsNotVisible(
          driver.findElement(By.css('#book_leave_modal'))
        ), 2000);
      })
      .then(function(){ done() })
      .catch(done);
  });

  it("Restores focus to the opener (Bootstrap data API behavior)", function(done){
    // Bootstrap 3.3.4 data API restores focus to the element that opened the
    // modal via [data-toggle="modal"]. This test pins that built-in behavior;
    // no custom focus-restoration code was added in this PR.
    driver
      .wait(function(){
        return driver.executeScript('return document.activeElement.id')
          .then(function(id){ return id === 'book_time_off_btn'; });
      }, 2000)
      .then(function(){ done() })
      .catch(done);
  });

  after(function(done){
    driver.quit().then(function(){ done() });
  });

});
