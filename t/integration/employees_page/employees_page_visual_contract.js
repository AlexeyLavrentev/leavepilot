'use strict';
const sizeViewport = require('../../lib/set_viewport');

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
  await sizeViewport(driver, { width: w, height: h });
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

describe('Employees directory page visual & interaction contract (Stage 8A v2)', function () {

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

  it('renders the scoped page with surfaces and the default active filter', async function () {
    await open_page_func({ url: application_host + 'users/', driver: driver });
    await driver.wait(until.elementLocated(By.css('.employees-page')), 2000);
    await driver.findElement(By.css('.employees-directory'));
    await driver.findElement(By.css('.employees-filter'));
    var active = await driver.findElement(By.css('.employees-filter .all-departments a[aria-current="true"]'));
    var activeText = await active.getText();
    assert(/All/i.test(activeText) || /Все/i.test(activeText), 'expected "All" filter active by default, got: ' + activeText);
  });

  // THE KEY v2 ADDITION: a real geometry check, not just a saved image.
  // Checks THREE things so inner clipping can't hide:
  //   1) page-level: no documentElement horizontal overflow
  //   2) cell-level: the name <td> right edge is within the viewport
  //   3) content-level: the inner <a>'s right edge is within the <td> AND viewport
  //      (catches the case where the cell fits but its link content overflows
  //      the grid track and is clipped by an inherited overflow:hidden)
  it('has NO horizontal overflow at 390x844 and link content is not clipped', async function () {
    await setViewport(driver, 390, 844);
    await open_page_func({ url: application_host + 'users/', driver: driver });
    await driver.wait(until.elementLocated(By.css('.employees-page')), 2000);
    await driver.sleep(300); // let layout/fonts settle
    var geo = await driver.executeScript(
      'var de=document.documentElement;' +
      'var nameCell=document.querySelector(".employees-directory td.user-link-cell, .employees-directory .user-link-cell");' +
      'var nameLink = nameCell ? nameCell.querySelector("a") : null;' +
      'var cr = nameCell ? nameCell.getBoundingClientRect() : null;' +
      'var lr = nameLink ? nameLink.getBoundingClientRect() : null;' +
      'return {' +
      '  scrollWidth: de.scrollWidth,' +
      '  clientWidth: de.clientWidth,' +
      '  innerWidth: window.innerWidth,' +
      '  cellRight: cr ? cr.right : null,' +
      '  cellWidth: cr ? cr.width : null,' +
      '  linkRight: lr ? lr.right : null,' +
      '  linkWidth: lr ? lr.width : null,' +
      '  viewportWidth: window.innerWidth' +
      '};'
    );
    // 1) page-level overflow
    assert(geo.scrollWidth <= geo.clientWidth + 1, 'horizontal overflow: scrollWidth=' + geo.scrollWidth + ' > clientWidth=' + geo.clientWidth);
    assert(geo.scrollWidth <= geo.innerWidth + 1, 'horizontal overflow: scrollWidth=' + geo.scrollWidth + ' > innerWidth=' + geo.innerWidth);
    // 2) cell within viewport
    assert(geo.cellRight !== null, 'expected an employee name cell to exist for the bounds check');
    assert(geo.cellRight <= geo.viewportWidth + 1, 'name cell right edge (' + geo.cellRight + ') exceeds viewport width (' + geo.viewportWidth + ')');
    // 3) inner link content within its cell AND viewport (the clipping guard)
    assert(geo.linkRight !== null, 'expected an <a> inside the name cell to measure');
    assert(geo.linkRight <= geo.cellRight + 1, 'name link right edge (' + geo.linkRight + ') exceeds its cell right edge (' + geo.cellRight + ') — link content overflows the grid track');
    assert(geo.linkRight <= geo.viewportWidth + 1, 'name link right edge (' + geo.linkRight + ') exceeds viewport width (' + geo.viewportWidth + ')');
  });

  it('captures 6 screenshots: 3 viewports x 2 themes', async function () {
    await open_page_func({ url: application_host + 'users/', driver: driver });
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
      await capture(driver, 'users_' + s.w + 'x' + s.h + '_' + s.theme);
    }
  });

  it('dark theme renders surfaces with a dark computed background', async function () {
    await setViewport(driver, 1440, 900);
    await open_page_func({ url: application_host + 'users/', driver: driver });
    await driver.wait(until.elementLocated(By.css('.employees-page')), 2000);
    await setTheme(driver, 'dark');
    var bg = await driver.executeScript(
      'var el=document.querySelector(".employees-page .surface");' +
      'return el ? getComputedStyle(el).backgroundColor : null;'
    );
    assert(/rgb\(26,\s*30,\s*34\)/.test(bg), 'expected dark surface background rgb(26,30,34), got: ' + bg);
  });

  it('moves aria-current to the chosen department and narrows the rows', async function () {
    await setViewport(driver, 1440, 900);
    await setTheme(driver, 'light');
    await open_page_func({ url: application_host + 'users/', driver: driver });
    await driver.wait(until.elementLocated(By.css('.employees-page')), 2000);
    var beforeRows = await driver.findElements(By.css('td.user_department'));
    assert(beforeRows.length >= 1, 'expected at least one user row before filtering');
    var deptLinks = await driver.findElements(By.css('.employees-aside .employees-filter .all-departments a'));
    assert(deptLinks.length >= 2, 'need >=1 department beyond "All", found ' + deptLinks.length);
    await deptLinks[1].click();
    await driver.wait(until.elementLocated(By.css('h1')), 2000);
    var active = await driver.findElement(By.css('.employees-filter .all-departments a[aria-current="true"]'));
    var activeText = (await active.getText()).trim();
    var cells = await driver.findElements(By.css('td.user_department'));
    assert(cells.length >= 1, 'expected >=1 row after filtering to ' + activeText);
    assert(cells.length <= beforeRows.length, 'filtering narrowed set: ' + cells.length + ' vs ' + beforeRows.length + ' before');
    for (var j = 0; j < cells.length; j++) {
      var t = (await cells[j].getText()).trim();
      assert.strictEqual(t, activeText, 'row department should match active filter');
    }
  });
});
