'use strict';
const setViewport = require('../lib/set_viewport');

var By               = require('selenium-webdriver').By,
    expect           = require('chai').expect,
    config           = require('../lib/config'),
    submit_form_func = require('../lib/submit_form'),
    register_new_user_func = require('../lib/register_new_user'),
    logout_user_func = require('../lib/logout_user'),
    build_driver     = require('../lib/build_driver'),
    application_host = config.get_application_host();
var itPremium = process.env.TIMEOFF_PREMIUM_MODULE ? it : it.skip;

var TEST_SAML_CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIICpDCCAYwCCQDi7W9j2X2g7DANBgkqhkiG9w0BAQsFADAWMRQwEgYDVQQDDAt0',
  'ZXN0LWlkcC1jZXJ0MB4XDTI2MDQwMTAwMDAwMFoXDTM2MDMyOTAwMDAwMFowFjEU',
  'MBIGA1UEAwwLdGVzdC1pZHAtY2VydDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC',
  'AQoCggEBANtYJ9P4l8Yuf2jVhQm4d3X0k8G8N7vN7i3v9sG5hYJ2cJ2Q2g1T8l1u8Y',
  'V7kM1w4s3m4kS8F3b2x8V0X9W9z4x2g7j0b1w2G6c9P2m4Q5v8u9u8s7r6q5p4o3n2',
  'm1l0k9j8h7g6f5e4d3c2b1a0Z9Y8X7W6V5U4T3S2R1Q0P9O8N7M6L5K4J3I2H1G0F',
  'E9D8C7B6A5Z4Y3X2W1V0U9T8S7R6Q5P4O3N2M1L0K9J8H7G6F5E4D3C2B1A0Z9Y8X7',
  'W6V5U4T3S2R1Q0P9O8N7M6L5K4J3I2H1G0FCAwEAATANBgkqhkiG9w0BAQsFAAOCAQ',
  'EAf0a1r9g1C2s3D4f5G6h7J8k9L0m1N2o3P4q5R6s7T8u9V0w1X2y3Z4a5B6c7D8e9',
  'f0g1h2i3j4k5l6m7n8o9p0q1r2s3t4u5v6w7x8y9z0=',
  '-----END CERTIFICATE-----'
].join('\n');

describe('Login page SSO UX', function(){

  this.timeout(config.get_execution_timeout());

  var driver, companyAdminEmail;

  before(function(){
    driver = build_driver();
    setViewport(driver, {width: 1024, height: 768});
    return driver.get(application_host + 'login/');
  });

  it('renders password login and a dedicated SSO entry point', function(){
    return driver.findElement(By.css('form#local_login_form'))
      .then(function(){
        return driver.findElement(By.css('form#local_login_form input[name="email"]'));
      })
      .then(function(){
        return driver.findElement(By.css('form#local_login_form input[name="password"]'));
      })
      .then(function(){
        return driver.findElements(By.css('form#sso_discovery_form'));
      })
      .then(function(ssoForms){
        expect(ssoForms).to.have.length(0);
      })
      .then(function(){
        return driver.findElement(By.css('#go_to_sso_login'));
      });
  });

  it('renders dedicated SSO discovery page', function(){
    return driver.get(application_host + 'login/sso/')
      .then(function(){
        return driver.findElement(By.css('form#sso_discovery_form input[name="email"]'));
      })
      .then(function(){
        return driver.findElements(By.css('form#sso_discovery_form input[name="password"]'));
      })
      .then(function(passwordInputs){
        expect(passwordInputs).to.have.length(0);
      })
      .then(function(){
        return driver.findElement(By.css('#submit_sso_login'));
      })
      .then(function(){
        return driver.findElement(By.css('#back_to_password_login'));
      });
  });

  itPremium('redirects password login into the SSO flow for SSO-enabled companies', function(done){
    register_new_user_func({
      application_host : application_host,
      driver           : driver,
    })
    .then(function(data){
      driver = data.driver;
      companyAdminEmail = data.email;

      return driver.get(application_host + 'settings/company/authentication/');
    })
    .then(function(){
      return submit_form_func({
        driver : driver,
        form_params : [{
          selector : '#sso_auth_enabled',
          tick     : true,
        }, {
          selector : '#sso_auth_provider',
          option_selector : 'option[value="saml"]',
        }, {
          selector : '#sso_login_alias',
          value    : 'sso-' + Date.now(),
        }, {
          selector : '#sso_entry_point',
          value    : application_host + 'login/',
        }, {
          selector : '#sso_idp_cert',
          value    : TEST_SAML_CERT,
        }],
        submit_button_selector : '#submit_registration',
        message : /SSO configuration was updated|updated successfully/i,
      });
    })
    .then(function(){
      return logout_user_func({
        application_host : application_host,
        driver           : driver,
      });
    })
    .then(function(){
      return driver.get(application_host + 'login/');
    })
    .then(function(){
      return driver.findElement(By.css('form#local_login_form input[name="email"]'))
        .then(function(el){
          return el.clear().then(function(){
            return el.sendKeys(companyAdminEmail);
          });
        })
        .then(function(){
          return driver.findElement(By.css('form#local_login_form input[name="password"]'));
        })
        .then(function(el){
          return el.clear().then(function(){
            return el.sendKeys('123456');
          });
        })
        .then(function(){
          return driver.findElement(By.css('#submit_login'));
        })
        .then(function(el){
          return el.click();
        })
        .then(function(){
          return driver.sleep(500);
        });
    })
    .then(function(){
      return driver.getCurrentUrl()
        .then(function(currentUrl){
          if (/SAMLRequest=/.test(currentUrl)) {
            return currentUrl;
          }

          return driver.sleep(1000).then(function(){
            return driver.getCurrentUrl();
          });
        });
    })
    .then(function(currentUrl){
      expect(currentUrl).to.match(/\/login\/\?(.*)SAMLRequest=/);
      expect(currentUrl).to.match(/RelayState=/);
      return driver.findElements(By.css('div.alert-danger'));
    })
    .then(function(errorAlerts){
      expect(errorAlerts).to.have.length(0);
      done();
    })
    .catch(done);
  });

  after(function(){
    return driver.quit();
  });
});
