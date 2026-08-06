'use strict';

/* globals describe, it, before, after */

/* Stage 8P — rendered Diagnostics Support Workspace contract. */

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

var SCREEN_DIR = '/tmp/stage8p-diagnostics';

async function setViewport(driver, width, height) {
  await sizeViewport(driver, { width: width, height: height });
  await driver.sleep(180);
}

async function openDiagnostics(driver, host) {
  await openPage({ url: host + 'settings/company/diagnostics/', driver: driver });
  await driver.wait(until.elementLocated(By.css('.diagnostics-page')), 3000);
  await driver.sleep(100);
}

async function setLanguage(driver, host, locale) {
  await openPage({ url: host + 'language/' + locale, driver: driver });
  await openDiagnostics(driver, host);
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

async function capture(driver, name) {
  if (!fs.existsSync(SCREEN_DIR)) fs.mkdirSync(SCREEN_DIR, { recursive: true });
  var target = path.join(SCREEN_DIR, name + '.png');
  fs.writeFileSync(target, await driver.takeScreenshot(), 'base64');
  assert(fs.statSync(target).size > 0, 'screenshot must be non-empty: ' + target);
}

function sensitiveKeys(value, pathPrefix, matches) {
  pathPrefix = pathPrefix || '';
  matches = matches || [];
  if (!value || typeof value !== 'object') return matches;
  Object.keys(value).forEach(function (key) {
    var current = pathPrefix ? pathPrefix + '.' + key : key;
    if (/(?:raw|signature|secret|password|token|private.?key|public.?key|authorization|cookie)/i.test(key)) {
      matches.push(current);
    }
    sensitiveKeys(value[key], current, matches);
  });
  return matches;
}

var MOBILE_GEOMETRY = function () {
  var page = document.querySelector('.diagnostics-page');
  var findings = [];
  var ranges = 0;
  var boxes = 0;
  var tolerance = 1;

  function hidden(element) {
    if (!element || element.offsetParent === null) return true;
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
      for (var index = 0; index < rects.length; index++) {
        var rect = rects[index];
        if (!rect.width || !rect.height) continue;
        ranges++;
        if (rect.left < boundary.left - tolerance || rect.right > boundary.right + tolerance ||
            rect.left < -tolerance || rect.right > window.innerWidth + tolerance) {
          findings.push(label + ' text [' + rect.left + ', ' + rect.right +
            '] outside [' + boundary.left + ', ' + boundary.right + ']');
        }
      }
    }

    var elements = container.querySelectorAll('a, summary, time, code, dt, dd, p, strong');
    for (var item = 0; item < elements.length; item++) {
      var element = elements[item];
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

  var surfaces = page.querySelectorAll('.surface');
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
  assert.strictEqual(result.surfaces, 4, '[' + locale + '] expected four surfaces');
  assert(result.ranges > 0 && result.boxes > 0,
    '[' + locale + '] geometry probe is vacuous: ' + JSON.stringify(result));
  assert(result.scrollWidth <= result.clientWidth + 1,
    '[' + locale + '] document overflow: ' + JSON.stringify(result));
  assert(result.scrollWidth <= result.innerWidth + 1,
    '[' + locale + '] viewport overflow: ' + JSON.stringify(result));
  assert.deepStrictEqual(result.findings, [],
    '[' + locale + '] geometry violations: ' + JSON.stringify(result.findings.slice(0, 20)));
}

describe('Diagnostics Support Workspace interaction contract (Stage 8P)', function () {
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

  it('renders four semantic surfaces without legacy tables or forms', async function () {
    await setViewport(driver, 1200, 850);
    await openDiagnostics(driver, host);
    var state = await driver.executeScript(function () {
      return {
        headings: document.querySelectorAll('.diagnostics-page h1').length,
        surfaces: document.querySelectorAll('.diagnostics-page .surface').length,
        tables: document.querySelectorAll('.diagnostics-page table').length,
        forms: document.querySelectorAll('.diagnostics-page form').length,
        detailLists: document.querySelectorAll('.diagnostics-detail-list').length,
        features: document.querySelectorAll('.diagnostics-feature-list li').length,
        previewOpen: document.querySelector('.diagnostics-preview').open,
        downloadPath: new URL(document.querySelector('.diagnostics-download').href).pathname,
        downloadAttribute: document.querySelector('.diagnostics-download').hasAttribute('download')
      };
    });
    assert.strictEqual(state.headings, 1);
    assert.strictEqual(state.surfaces, 4);
    assert.strictEqual(state.tables, 0);
    assert.strictEqual(state.forms, 0);
    assert.strictEqual(state.detailLists, 2);
    assert(state.features > 0, 'feature status list must be non-empty');
    assert.strictEqual(state.previewOpen, false);
    assert.strictEqual(state.downloadPath, '/settings/company/diagnostics.json');
    assert.strictEqual(state.downloadAttribute, true);
  });

  it('does not request or transmit the snapshot when the disclosure opens', async function () {
    await openDiagnostics(driver, host);
    var requestsBefore = await driver.executeScript(function () {
      return performance.getEntriesByType('resource').filter(function (entry) {
        return new URL(entry.name).pathname === '/settings/company/diagnostics.json';
      }).length;
    });
    assert.strictEqual(requestsBefore, 0);
    await driver.findElement(By.id('diagnostics_preview_toggle')).click();
    var previewText = await driver.findElement(By.css('#diagnostics_json_preview code')).getText();
    var snapshot = JSON.parse(previewText);
    assert.strictEqual(sensitiveKeys(snapshot).length, 0,
      'preview must contain no sensitive keys: ' + sensitiveKeys(snapshot).join(', '));
    var requestsAfter = await driver.executeScript(function () {
      return performance.getEntriesByType('resource').filter(function (entry) {
        return new URL(entry.name).pathname === '/settings/company/diagnostics.json';
      }).length;
    });
    assert.strictEqual(requestsAfter, 0, 'native disclosure must not fetch or upload data');
  });

  it('downloads the same sanitized snapshot with attachment and no-store headers', async function () {
    await openDiagnostics(driver, host);
    var response = await driver.executeAsyncScript(function (done) {
      fetch('/settings/company/diagnostics.json', { credentials: 'same-origin' })
        .then(function (result) {
          var headers = {
            cacheControl: result.headers.get('cache-control'),
            contentDisposition: result.headers.get('content-disposition'),
            contentType: result.headers.get('content-type')
          };
          return result.text().then(function (body) {
            done({ headers: headers, body: body, status: result.status });
          });
        })
        .catch(function (error) { done({ error: error.name }); });
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.cacheControl, 'no-store');
    assert(response.headers.contentDisposition.indexOf('leavepilot-diagnostics.json') !== -1);
    assert(response.headers.contentType.indexOf('application/json') !== -1);
    var snapshot = JSON.parse(response.body);
    assert.strictEqual(sensitiveKeys(snapshot).length, 0,
      'download must contain no sensitive keys: ' + sensitiveKeys(snapshot).join(', '));
  });

  it('keeps the complete closed and open disclosure Tab order visible', async function () {
    await setViewport(driver, 390, 844);
    await openDiagnostics(driver, host);
    await collapseMobileNav(driver);

    async function walk() {
      await driver.executeScript('document.querySelector(".diagnostics-page").focus()');
      var visited = [];
      var entered = false;
      for (var index = 0; index < 20; index++) {
        await driver.actions().sendKeys(Key.TAB).perform();
        var focus = await driver.executeScript(function () {
          var active = document.activeElement;
          var rect = active.getBoundingClientRect();
          return {
            inside: !!active.closest('.diagnostics-page'),
            id: active.id || '',
            height: rect.height,
            outline: getComputedStyle(active).outlineStyle,
            visible: getComputedStyle(active).display !== 'none' && active.offsetParent !== null
          };
        });
        if (focus.inside) {
          entered = true;
          visited.push(focus);
        } else if (entered) {
          break;
        }
      }
      return visited;
    }

    var closed = await walk();
    assert.deepStrictEqual(closed.map(function (item) { return item.id; }), [
      '', 'diagnostics_preview_toggle'
    ]);
    await driver.findElement(By.id('diagnostics_preview_toggle')).click();
    var opened = await walk();
    assert.deepStrictEqual(opened.map(function (item) { return item.id; }), [
      '', 'diagnostics_preview_toggle', 'diagnostics_json_preview'
    ]);
    assert(opened.every(function (item) { return item.visible; }));
    assert(opened.slice(0, 2).every(function (item) { return item.height >= 43.5; }));
    assert(opened.some(function (item) { return item.outline !== 'none'; }),
      'focusable diagnostics controls must expose a focus ring');
  });

  it('has no mobile overflow in EN, RU or KK', async function () {
    await setViewport(driver, 390, 844);
    for (const locale of ['en', 'ru', 'kk']) {
      await setLanguage(driver, host, locale);
      await assertMobileGeometry(driver, locale);
    }
    await setLanguage(driver, host, 'en');
  });

  it('keeps status and privacy guidance at WCAG AA contrast in light and dark', async function () {
    await setViewport(driver, 1200, 850);
    await openDiagnostics(driver, host);
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
        var status = document.querySelector('.diagnostics-status');
        var note = document.querySelector('.diagnostics-privacy-note');
        return {
          status: ratio(getComputedStyle(status).color, getComputedStyle(status).backgroundColor),
          note: ratio(getComputedStyle(note).color, getComputedStyle(note).backgroundColor)
        };
      });
      assert(ratios.status >= 4.5, theme + ' status contrast: ' + ratios.status);
      assert(ratios.note >= 4.5, theme + ' note contrast: ' + ratios.note);
    }
    await setTheme(driver, 'light');
  });

  it('neutralizes disclosure press feedback under reduced motion', async function () {
    await openDiagnostics(driver, host);
    await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    assert(await driver.executeScript(
      'return matchMedia("(prefers-reduced-motion: reduce)").matches'
    ));
    var summary = await driver.findElement(By.id('diagnostics_preview_toggle'));
    await driver.actions().move({ origin: summary }).press().perform();
    var transform = await driver.executeScript(
      'return getComputedStyle(arguments[0]).transform', summary
    );
    await driver.actions().release().perform();
    assert.strictEqual(transform, 'none');
    await driver.sendDevToolsCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
    });
  });

  it('captures an eight-case closed-snapshot visual matrix', async function () {
    var cases = [
      ['en', 1440, 900, 'light'],
      ['en', 1440, 900, 'dark'],
      ['en', 390, 844, 'light'],
      ['en', 390, 844, 'dark'],
      ['ru', 1440, 900, 'light'],
      ['ru', 390, 844, 'dark'],
      ['kk', 1440, 900, 'dark'],
      ['kk', 390, 844, 'light']
    ];
    for (var index = 0; index < cases.length; index++) {
      var item = cases[index];
      await setViewport(driver, item[1], item[2]);
      await setLanguage(driver, host, item[0]);
      await setTheme(driver, item[3]);
      assert.strictEqual(await driver.executeScript(
        'return document.querySelector(".diagnostics-preview").open'
      ), false, 'visual artifacts must keep raw JSON collapsed');
      await capture(driver, item[0] + '-' + item[1] + '-' + item[3]);
    }
    await setLanguage(driver, host, 'en');
    await setTheme(driver, 'light');
    assert.strictEqual(fs.readdirSync(SCREEN_DIR).filter(function (file) {
      return file.endsWith('.png');
    }).length, 8);
  });
});
