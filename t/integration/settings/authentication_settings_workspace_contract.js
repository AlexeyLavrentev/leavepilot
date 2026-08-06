'use strict';

/* globals describe, it, before, after */

/*
 * Stage 8L — rendered Authentication Settings Workspace contract.
 *
 * No authentication settings are submitted here. Existing route unit tests
 * exercise persistence, secret preservation and generic LDAP failures.
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var webdriver = require('selenium-webdriver');
var By = webdriver.By;
var Key = webdriver.Key;
var until = webdriver.until;
var config = require('../../lib/config');
var registerNewUser = require('../../lib/register_new_user');
var openPage = require('../../lib/open_page');
const sizeViewport = require('../../lib/set_viewport');

var SCREEN_DIR = '/tmp/stage8l-authentication-settings';

async function setViewport(driver, width, height) {
  await sizeViewport(driver, { width: width, height: height });
  await driver.sleep(180);
}

async function openSettings(driver, host) {
  await openPage({ url: host + 'settings/company/authentication/', driver: driver });
  await driver.wait(until.elementLocated(By.css('.authentication-settings-page')), 3000);
  await driver.sleep(100);
}

async function setLanguage(driver, host, locale) {
  await openPage({ url: host + 'language/' + locale, driver: driver });
  await openSettings(driver, host);
}

async function collapseMobileNav(driver) {
  var expanded = await driver.findElements(By.css('.navbar-toggle[aria-expanded="true"]'));
  if (expanded.length) {
    await expanded[0].click();
    await driver.sleep(220);
  }
}

async function setTheme(driver, theme) {
  var mobileToggle = await driver.findElements(By.css('.navbar-toggle'));
  if (mobileToggle.length && await mobileToggle[0].isDisplayed()) {
    var expanded = await mobileToggle[0].getAttribute('aria-expanded');
    if (expanded !== 'true') {
      await mobileToggle[0].click();
      await driver.sleep(180);
    }
  }
  await driver.findElement(By.css('#theme-menu .dropdown-toggle')).click();
  await driver.findElement(By.css('[data-theme-value="' + theme + '"]')).click();
  await driver.sleep(220);
  await collapseMobileNav(driver);
}

async function chooseProvider(driver, value) {
  var option = await driver.findElement(By.css(
    '#sso_auth_provider option[value="' + value + '"]'
  ));
  await option.click();
  await driver.sleep(100);
}

async function capture(driver, name) {
  if (!fs.existsSync(SCREEN_DIR)) fs.mkdirSync(SCREEN_DIR, { recursive: true });
  var target = path.join(SCREEN_DIR, name + '.png');
  fs.writeFileSync(target, await driver.takeScreenshot(), 'base64');
  assert(fs.statSync(target).size > 0, 'screenshot must be non-empty: ' + target);
}

var MOBILE_GEOMETRY = function () {
  var page = document.querySelector('.authentication-settings-page');
  var findings = [];
  var ranges = 0;
  var boxes = 0;
  var tolerance = 1;

  function hidden(element) {
    while (element && element !== document.body) {
      var style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' ||
          element.getAttribute('aria-hidden') === 'true') return true;
      element = element.parentElement;
    }
    return false;
  }

  function inspect(container, label) {
    if (hidden(container)) return;
    var boundary = container.getBoundingClientRect();
    if (container.scrollWidth > container.clientWidth + 2) {
      findings.push(label + ' scrollWidth ' + container.scrollWidth + ' > ' + container.clientWidth);
    }

    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (!(node.nodeValue || '').trim() || hidden(node.parentElement)) continue;
      var range = document.createRange();
      range.selectNodeContents(node);
      var rects = range.getClientRects();
      for (var i = 0; i < rects.length; i++) {
        var rect = rects[i];
        if (!rect.width || !rect.height) continue;
        ranges++;
        if (rect.left < boundary.left - tolerance || rect.right > boundary.right + tolerance ||
            rect.left < -tolerance || rect.right > window.innerWidth + tolerance) {
          findings.push(label + ' text [' + rect.left + ', ' + rect.right +
            '] outside [' + boundary.left + ', ' + boundary.right + ']');
        }
      }
    }

    var elements = container.querySelectorAll('input:not([type="hidden"]), select, textarea, button, label, code');
    for (var j = 0; j < elements.length; j++) {
      var element = elements[j];
      if (hidden(element)) continue;
      var box = element.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      boxes++;
      if (box.left < boundary.left - tolerance || box.right > boundary.right + tolerance ||
          box.left < -tolerance || box.right > window.innerWidth + tolerance) {
        findings.push(label + ' ' + element.tagName + ' [' + box.left + ', ' + box.right +
          '] outside [' + boundary.left + ', ' + boundary.right + ']');
      }
    }
  }

  var surfaces = page.querySelectorAll('.authentication-settings-section');
  for (var index = 0; index < surfaces.length; index++) inspect(surfaces[index], 'surface-' + index);

  return {
    surfaces: surfaces.length,
    ranges: ranges,
    boxes: boxes,
    findings: findings,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    innerWidth: window.innerWidth
  };
};

async function assertMobileGeometry(driver, locale) {
  var result = await driver.executeScript(MOBILE_GEOMETRY);
  assert.strictEqual(result.surfaces, 3, '[' + locale + '] expected three surfaces');
  assert(result.ranges > 0 && result.boxes > 0,
    '[' + locale + '] geometry probe is vacuous: ' + JSON.stringify(result));
  assert(result.scrollWidth <= result.clientWidth + 1,
    '[' + locale + '] document overflow: ' + JSON.stringify(result));
  assert(result.scrollWidth <= result.innerWidth + 1,
    '[' + locale + '] viewport overflow: ' + JSON.stringify(result));
  assert.deepStrictEqual(result.findings, [],
    '[' + locale + '] geometry violations: ' + JSON.stringify(result.findings.slice(0, 20)));
}

describe('Authentication Settings interaction and visual contract (Stage 8L)', function () {
  this.timeout(config.get_execution_timeout());

  var driver;
  var host = config.get_application_host();

  before(function (done) {
    registerNewUser({ application_host: host }).then(function (data) {
      driver = data.driver;
      done();
    }, done);
  });

  after(async function () {
    if (driver) await driver.quit();
  });

  it('renders one protected form and all three workspace surfaces', async function () {
    await setViewport(driver, 1440, 900);
    await openSettings(driver, host);
    var contract = await driver.executeScript(function () {
      var form = document.querySelector('.authentication-settings-form');
      var secret = document.getElementById('sso_client_secret');
      return {
        headings: document.querySelectorAll('.authentication-settings-page h1').length,
        forms: document.querySelectorAll('.authentication-settings-page form').length,
        method: form.method.toLowerCase(),
        path: new URL(form.action).pathname,
        csrf: !!form.querySelector('input[name="_csrf"]'),
        surfaces: document.querySelectorAll('.authentication-settings-section').length,
        secretType: secret.type,
        secretValue: secret.value
      };
    });
    assert.deepStrictEqual(contract, {
      headings: 1,
      forms: 1,
      method: 'post',
      path: '/settings/company/authentication/',
      csrf: true,
      surfaces: 3,
      secretType: 'password',
      secretValue: ''
    });
  });

  it('switches OIDC and SAML groups with the existing selector controller', async function () {
    await openSettings(driver, host);
    var state = async function () {
      return driver.executeScript(function () {
        function displayed(selector) {
          return Array.prototype.map.call(document.querySelectorAll(selector), function (element) {
            return getComputedStyle(element).display !== 'none';
          });
        }
        return {
          oidc: displayed('[data-sso-provider-section="oidc"]'),
          saml: displayed('[data-sso-provider-section="saml"]')
        };
      });
    };
    assert.deepStrictEqual(await state(), { oidc: [true, true], saml: [false, false] });
    await chooseProvider(driver, 'saml');
    assert.deepStrictEqual(await state(), { oidc: [false, false], saml: [true, true] });
    await chooseProvider(driver, 'oidc');
    assert.deepStrictEqual(await state(), { oidc: [true, true], saml: [false, false] });
  });

  it('keeps hidden provider fields out of a complete mobile Tab walk', async function () {
    await setViewport(driver, 390, 844);
    await openSettings(driver, host);
    await collapseMobileNav(driver);
    await driver.executeScript('document.querySelector(".authentication-settings-page").focus()');
    var visited = [];
    var entered = false;
    for (var index = 0; index < 80; index++) {
      await driver.actions().sendKeys(Key.TAB).perform();
      var focus = await driver.executeScript(function () {
        var active = document.activeElement;
        return {
          inside: !!active.closest('.authentication-settings-page'),
          id: active.id || '',
          outline: getComputedStyle(active).outlineStyle,
          display: getComputedStyle(active).display
        };
      });
      if (focus.inside) {
        entered = true;
        visited.push(focus);
      } else if (entered) {
        break;
      }
    }
    assert(visited.length > 10, 'Tab walk must traverse the form non-vacuously');
    assert(visited.some(function (item) { return item.id === 'sso_auth_provider'; }));
    assert(visited.some(function (item) { return item.id === 'sso_client_id'; }));
    assert(visited.some(function (item) { return item.id === 'submit_registration'; }));
    assert(!visited.some(function (item) { return item.id === 'sso_entry_point'; }),
      'hidden SAML controls must not enter the OIDC Tab order');
    assert(visited.every(function (item) { return item.display !== 'none'; }));
    assert(visited.some(function (item) { return item.outline !== 'none'; }),
      'at least one form control must expose a visible focus outline');
  });

  it('mobile controls and option labels meet the 44px target contract', async function () {
    await setViewport(driver, 390, 844);
    await openSettings(driver, host);
    var sizes = await driver.executeScript(function () {
      var elements = document.querySelectorAll(
        '.authentication-settings-page .form-control, ' +
        '.authentication-settings-page .authentication-settings-toggle-label, ' +
        '.authentication-settings-page #submit_registration'
      );
      return Array.prototype.filter.call(elements, function (element) {
        return getComputedStyle(element).display !== 'none' && element.offsetParent !== null;
      }).map(function (element) {
        var rect = element.getBoundingClientRect();
        return { id: element.id || element.getAttribute('for') || element.tagName, height: rect.height };
      });
    });
    assert(sizes.length > 12, '44px probe must cover the rendered form');
    sizes.forEach(function (size) {
      assert(size.height >= 43.5, size.id + ' height is ' + size.height + 'px');
    });
  });

  it('has no mobile overflow in EN, RU or KK with either provider visible', async function () {
    await setViewport(driver, 390, 844);
    for (const testCase of [['en', 'oidc'], ['ru', 'saml'], ['kk', 'oidc']]) {
      await setLanguage(driver, host, testCase[0]);
      await chooseProvider(driver, testCase[1]);
      await assertMobileGeometry(driver, testCase[0] + '-' + testCase[1]);
    }
    await setLanguage(driver, host, 'en');
  });

  it('warning and supporting copy meet WCAG AA in light and dark', async function () {
    await setViewport(driver, 1200, 850);
    await openSettings(driver, host);
    for (const theme of ['light', 'dark']) {
      await setTheme(driver, theme);
      var ratios = await driver.executeScript(function () {
        function channels(value) {
          return (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        }
        function luminance(value) {
          return channels(value).map(function (part) {
            part /= 255;
            return part <= 0.03928 ? part / 12.92 : Math.pow((part + 0.055) / 1.055, 2.4);
          }).reduce(function (sum, part, index) {
            return sum + part * [0.2126, 0.7152, 0.0722][index];
          }, 0);
        }
        function ratio(foreground, background) {
          var light = Math.max(luminance(foreground), luminance(background));
          var dark = Math.min(luminance(foreground), luminance(background));
          return (light + 0.05) / (dark + 0.05);
        }
        var warning = document.querySelector('.authentication-settings-security-warning');
        var help = document.querySelector('.authentication-settings-ldap .help-block');
        var surface = document.querySelector('.authentication-settings-ldap');
        return {
          warning: ratio(getComputedStyle(warning).color, getComputedStyle(warning).backgroundColor),
          help: ratio(getComputedStyle(help).color, getComputedStyle(surface).backgroundColor)
        };
      });
      assert(ratios.warning >= 4.5, theme + ' warning contrast: ' + ratios.warning);
      assert(ratios.help >= 4.5, theme + ' help contrast: ' + ratios.help);
    }
    await setTheme(driver, 'light');
  });

  it('neutralizes press transform under emulated reduced motion', async function () {
    await openSettings(driver, host);
    await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    assert(await driver.executeScript(
      'return matchMedia("(prefers-reduced-motion: reduce)").matches'
    ));
    var button = await driver.findElement(By.css('#submit_registration'));
    await driver.actions().move({ origin: button }).press().perform();
    var transform = await driver.executeScript(
      'return getComputedStyle(arguments[0]).transform', button
    );
    await driver.actions().release().perform();
    assert.strictEqual(transform, 'none', 'reduced-motion press transform: ' + transform);
    await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
    });
  });

  it('captures the 12-case visual matrix', async function () {
    var cases = [
      ['en', 'oidc', 1440, 900, 'light'],
      ['en', 'oidc', 1440, 900, 'dark'],
      ['en', 'saml', 1440, 900, 'light'],
      ['en', 'saml', 1440, 900, 'dark'],
      ['en', 'oidc', 390, 844, 'light'],
      ['en', 'oidc', 390, 844, 'dark'],
      ['en', 'saml', 390, 844, 'light'],
      ['en', 'saml', 390, 844, 'dark'],
      ['ru', 'oidc', 390, 844, 'light'],
      ['ru', 'saml', 390, 844, 'dark'],
      ['kk', 'oidc', 390, 844, 'light'],
      ['kk', 'saml', 390, 844, 'dark']
    ];
    for (var index = 0; index < cases.length; index++) {
      var item = cases[index];
      await setViewport(driver, item[2], item[3]);
      await setLanguage(driver, host, item[0]);
      await chooseProvider(driver, item[1]);
      await setTheme(driver, item[4]);
      if (item[1] === 'saml') {
        await driver.executeScript(
          'document.querySelector(".authentication-settings-provider").scrollIntoView({block:"start"})'
        );
        await driver.sleep(120);
      }
      await capture(driver, item[0] + '-' + item[1] + '-' + item[2] + '-' + item[4]);
    }
    await setLanguage(driver, host, 'en');
    await setTheme(driver, 'light');
    assert.strictEqual(fs.readdirSync(SCREEN_DIR).filter(function (file) {
      return file.endsWith('.png');
    }).length, 12);
  });
});
