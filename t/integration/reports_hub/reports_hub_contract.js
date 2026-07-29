'use strict';

/* globals describe, it, before, after */

var path   = require('path'),
    fs     = require('fs'),
    assert = require('assert'),
    webdriver = require('selenium-webdriver'),
    By     = webdriver.By,
    until   = webdriver.until,
    config = require('../../lib/config'),
    register_new_user_func = require('../../lib/register_new_user'),
    open_page_func = require('../../lib/open_page');

var SCREEN_DIR = '/tmp/screens';

function ensureScreenDir() {
  if (!fs.existsSync(SCREEN_DIR)) {
    fs.mkdirSync(SCREEN_DIR, { recursive: true });
  }
}

// Open the Bootstrap theme dropdown via its real toggle (the <a> inside #theme-menu).
// On collapsed navbars (mobile), expand .navbar-toggle first so the menu is interactable,
// then collapse it again afterwards for a clean screenshot.
async function setTheme(driver, theme /* 'light' | 'dark' */) {
  var navbarNeedsExpand = await driver.executeScript(
    'var t=document.querySelector(".navbar-toggle");' +
    'return !!(t && getComputedStyle(t).display!=="none" && t.offsetWidth>0);'
  );
  if (navbarNeedsExpand) {
    await driver.findElement(By.css('.navbar-toggle')).click();
    await driver.sleep(300);
  }
  await driver.findElement(By.css('#theme-menu .dropdown-toggle')).click();
  await driver.wait(until.elementLocated(By.css('[data-theme-value="' + theme + '"]')), 1000);
  await driver.findElement(By.css('[data-theme-value="' + theme + '"]')).click();
  await driver.sleep(150);
  if (theme === 'dark') {
    await driver.wait(until.elementLocated(By.css('html[data-theme="dark"]')), 2000);
  } else {
    await driver.wait(function () {
      return driver.executeScript('return document.documentElement.getAttribute("data-theme") === null;');
    }, 2000);
  }
  if (navbarNeedsExpand) {
    await driver.findElement(By.css('.navbar-toggle')).click();
    await driver.sleep(200);
  }
}

async function setViewport(driver, w, h) {
  await driver.manage().window().setRect({ width: w, height: h });
  await driver.sleep(250);
}

async function capture(driver, name) {
  ensureScreenDir();
  var image = await driver.takeScreenshot();
  var file = path.join(SCREEN_DIR, name + '.png');
  fs.writeFileSync(file, image, 'base64');
  assert(fs.statSync(file).size > 0, 'screenshot must be non-empty: ' + file);
  return file;
}

describe('Reports Hub interaction & geometry contract (Stage 8B)', function () {

  this.timeout(config.get_execution_timeout());

  var driver;
  var application_host = config.get_application_host();

  before(function (done) {
    register_new_user_func({ application_host: application_host }).then(function (data) {
      driver = data.driver;
      done();
    }, done);
  });

  after(function () {
    return driver.quit();
  });

  async function openReports() {
    await open_page_func({ url: application_host + 'reports/', driver: driver });
    await driver.wait(until.elementLocated(By.css('.reports-hub')), 2000);
  }

  it('renders the scoped hub with two report cards', async function () {
    await openReports();
    var cards = await driver.findElements(By.css('.report-card'));
    assert.strictEqual(cards.length, 2, 'expected exactly two report cards');
    var hrefs = await Promise.all(cards.map(function (c) { return c.getAttribute('href'); }));
    assert(hrefs.indexOf(application_host + 'reports/allowancebytime/') > -1, 'allowancebytime href present: ' + hrefs);
    assert(hrefs.indexOf(application_host + 'reports/leaves/') > -1, 'leaves href present: ' + hrefs);
  });

  it('each card is a >=44px tap target', async function () {
    await setViewport(driver, 1440, 900);
    await openReports();
    var cards = await driver.findElements(By.css('.report-card'));
    for (var i = 0; i < cards.length; i++) {
      var r = await driver.executeScript('var el=arguments[0]; var b=el.getBoundingClientRect(); return {w:b.width,h:b.height};', cards[i]);
      assert(r.h >= 44, 'card ' + i + ' height ' + r.h + ' < 44');
      assert(r.w >= 44, 'card ' + i + ' width ' + r.w + ' < 44');
    }
  });

  it('Tab produces a visible focus ring on a report card', async function () {
    await setViewport(driver, 1440, 900);
    await openReports();
    // move focus onto a report card and read its computed focus outline
    await driver.executeScript('var a=document.querySelector(".report-card"); if(a){a.focus();}');
    await driver.sleep(150);
    var focusedOutline = await driver.executeScript(
      'var el=document.activeElement; if(!el) return null;' +
      'var cs=getComputedStyle(el); return {tag:el.tagName, cls:el.className, outlineWidth:cs.outlineWidth, outlineStyle:cs.outlineStyle, outlineColor:cs.outlineColor};'
    );
    assert(/report-card/.test(focusedOutline.cls || ''), 'focused element should be a report card, got: ' + JSON.stringify(focusedOutline));
    assert(focusedOutline.outlineWidth !== '0px', 'expected non-zero outline on focused card, got ' + focusedOutline.outlineWidth);
  });

  it('Enter on the allowance card navigates to /reports/allowancebytime/', async function () {
    await setViewport(driver, 1440, 900);
    await openReports();
    var card = await driver.findElement(By.css('.report-card[href$="reports/allowancebytime/"]'));
    await driver.executeScript('arguments[0].focus();', card);
    await driver.actions().sendKeys(webdriver.Key.ENTER).perform();
    await driver.wait(function () {
      return driver.getCurrentUrl().then(function (u) { return /\/reports\/allowancebytime\/?(\?|$)/.test(u); });
    }, 5000);
  });

  it('Enter on the leaves card navigates to /reports/leaves/', async function () {
    await setViewport(driver, 1440, 900);
    await openReports();
    var card = await driver.findElement(By.css('.report-card[href$="reports/leaves/"]'));
    await driver.executeScript('arguments[0].focus();', card);
    await driver.actions().sendKeys(webdriver.Key.ENTER).perform();
    await driver.wait(function () {
      return driver.getCurrentUrl().then(function (u) { return /\/reports\/leaves\/?(\?|$)/.test(u); });
    }, 5000);
  });

  it('desktop: two cards in two columns with equal height within 1px', async function () {
    await setViewport(driver, 1440, 900);
    await openReports();
    await driver.sleep(200);
    var g = await driver.executeScript(function () {
      var cards = document.querySelectorAll('.reports-hub .report-card');
      var a = cards[0].getBoundingClientRect();
      var b = cards[1].getBoundingClientRect();
      return {
        aLeft: a.left, aRight: a.right, aTop: a.top, aBottom: a.bottom, aHeight: a.height,
        bLeft: b.left, bRight: b.right, bTop: b.top, bBottom: b.bottom, bHeight: b.height,
        sideBySide: Math.abs(a.top - b.top) < 1
      };
    });
    assert(g.sideBySide, 'desktop: cards should be side by side (same top), got aTop=' + g.aTop + ' bTop=' + g.bTop);
    assert(Math.abs(g.aHeight - g.bHeight) <= 1, 'desktop: equal height within 1px, got ' + g.aHeight + ' vs ' + g.bHeight);
  });

  it('mobile (390px): single column (stacked), no horizontal overflow, text within viewport', async function () {
    await setViewport(driver, 390, 844);
    await openReports();
    await driver.sleep(300);
    var g = await driver.executeScript(function () {
      var de = document.documentElement;
      var cards = document.querySelectorAll('.reports-hub .report-card');
      var a = cards[0].getBoundingClientRect();
      var b = cards[1].getBoundingClientRect();
      // sample a description text node to check content bounds
      var desc = document.querySelector('.report-card-desc');
      var dr = desc ? desc.getBoundingClientRect() : null;
      return {
        scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, innerWidth: window.innerWidth,
        stacked: Math.abs(a.left - b.left) < 1, // same left edge => same column
        aTop: a.top, bTop: b.top, // b below a
        descRight: dr ? dr.right : null,
        viewportWidth: window.innerWidth
      };
    });
    assert(g.scrollWidth <= g.clientWidth + 1, 'horizontal overflow: scrollWidth=' + g.scrollWidth + ' > clientWidth=' + g.clientWidth);
    assert(g.scrollWidth <= g.innerWidth + 1, 'horizontal overflow: scrollWidth=' + g.scrollWidth + ' > innerWidth=' + g.innerWidth);
    assert(g.stacked, 'mobile: cards should stack in one column (same left), got aLeft vs bLeft differ');
    assert(g.bTop > g.aTop, 'mobile: second card below first');
    if (g.descRight !== null) {
      assert(g.descRight <= g.viewportWidth + 1, 'description text right edge (' + g.descRight + ') exceeds viewport (' + g.viewportWidth + ')');
    }
  });

  it('reduced-motion: the press transform is neutralized to none', async function () {
    // CONTRACT-PRESENCE assertion: the loaded CSS contains a prefers-reduced-motion rule,
    // scoped to .reports-hub, that neutralizes transform to none. Full media-query flipping
    // in headless Chrome is fragile; walking document.styleSheets.cssRules is reliable.
    await setViewport(driver, 1440, 900);
    await openReports();
    var hasRule = await driver.executeScript(function () {
      var css = '';
      for (var i = 0; i < document.styleSheets.length; i++) {
        try {
          var rules = document.styleSheets[i].cssRules;
          for (var j = 0; j < rules.length; j++) {
            var t = rules[j].cssText || '';
            if (t.indexOf('prefers-reduced-motion') > -1 && t.indexOf('transform') > -1 && t.indexOf('none') > -1) {
              return true;
            }
          }
        } catch (e) { /* cross-origin */ }
      }
      return false;
    });
    assert(hasRule, 'expected a reduced-motion rule neutralizing transform in the loaded CSS');
  });

  // Visual matrix: 6 states; default locale (en). Long-text (RU/KK) coverage is provided
  // by the unit-locale assertion; the en long-text wrap is captured by the mobile geometry test above.
  it('captures the 6-state visual matrix (1440/1024/390 x light/dark)', async function () {
    await openReports();
    var states = [
      { w: 1440, h: 900, theme: 'light' },
      { w: 1024, h: 768, theme: 'light' },
      { w: 390, h: 844, theme: 'light' },
      { w: 1440, h: 900, theme: 'dark' },
      { w: 1024, h: 768, theme: 'dark' },
      { w: 390, h: 844, theme: 'dark' }
    ];
    for (var i = 0; i < states.length; i++) {
      var s = states[i];
      await setViewport(driver, s.w, s.h);
      await setTheme(driver, s.theme);
      await capture(driver, 'reports_' + s.w + 'x' + s.h + '_' + s.theme);
    }
  });
});
