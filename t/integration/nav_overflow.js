'use strict';

/*
 * Primary navigation overflow, measured in a browser.
 *
 * Core's own row fits at every desktop width, so the case worth testing — an
 * edition adding enough items that the row runs out of track — has to be built
 * here. The items are put on the row the same way an edition's are rendered
 * onto it, and the script is expected to pick them up.
 *
 * What this guards is the promise the row makes: an item may end up behind a
 * control, but it never ends up off the edge with nothing pointing at it, and
 * the action button is never the item that goes.
 */

const expect = require('chai').expect;

const buildDriver = require('../lib/build_driver');
const config = require('../lib/config');
const registerNewUser = require('../lib/register_new_user');
const openPage = require('../lib/open_page');
const setViewport = require('../lib/set_viewport');

const applicationHost = config.get_application_host();

const STATE = `
  const nav = document.querySelector('.primary-navigation');
  const overflow = nav.querySelector('[data-nav-overflow]');
  const menu = overflow.querySelector('.nav-overflow-menu');
  const text = li => li.textContent.replace(/\\s+/g, ' ').trim();
  const bar = Array.from(nav.children).filter(li => li !== overflow);
  return {
    overflowPx: nav.scrollWidth - nav.clientWidth,
    toggleHidden: overflow.classList.contains('hidden'),
    managed: nav.classList.contains('nav-overflow-managed'),
    bar: bar.map(text),
    menu: Array.from(menu.children).map(text),
    ctaOnBar: bar.some(li => li.querySelector('#book_time_off_btn')),
    injectedOnBar: bar.filter(li => li.classList.contains('injected-nav-item')).length,
    injectedInMenu: Array.from(menu.children)
      .filter(li => li.classList.contains('injected-nav-item')).length,
  };
`;

const INJECT = `
  const nav = document.querySelector('.primary-navigation');
  const overflow = nav.querySelector('[data-nav-overflow]');

  for (let index = 0; index < arguments[0]; index += 1) {
    const item = document.createElement('li');
    item.className = 'injected-nav-item';
    item.innerHTML = '<a href="#injected-' + index + '">Injected item ' + index + '</a>';
    nav.insertBefore(item, overflow);
  }

  window.dispatchEvent(new Event('resize'));
`;

// The layout pass is batched into an animation frame, so a second frame is one
// frame after the work this is waiting on.
const SETTLE = `
  const done = arguments[arguments.length - 1];
  window.requestAnimationFrame(function() {
    window.requestAnimationFrame(done);
  });
`;

describe('Primary navigation collapses what will not fit', function() {
  this.timeout(config.get_execution_timeout());

  const INJECTED = 8;
  let driver;

  after(async function() {
    if (driver) {
      await driver.quit();
      driver = null;
    }
  });

  async function state(width) {
    if (width) {
      await setViewport(driver, {width, height: 900});
    }
    await driver.executeAsyncScript(SETTLE);
    return driver.executeScript(STATE);
  }

  it('creates a company and opens a page with the row on it', async function() {
    /*
      Language detection falls back to the browser's own Accept-Language, so a
      developer machine set to anything but English registers through a
      different set of labels than CI does. Pinning it first keeps the fixture
      the same everywhere; nothing below reads a label.
    */
    driver = buildDriver();
    await driver.get(applicationHost + 'language/en');

    ({driver} = await registerNewUser({applicationHost, driver}));
    await openPage({url: applicationHost + 'calendar/', driver});

    const wide = await state(1920);

    expect(wide.managed, 'the script did not take the row over').to.be.true;
  });

  it('leaves the row alone while core\'s own items fit it', async function() {
    const wide = await state(1920);

    expect(wide.overflowPx).to.be.at.most(1);
    expect(wide.menu).to.be.empty;
    expect(wide.toggleHidden, 'an empty menu must not advertise itself').to.be.true;
  });

  it('moves the items an edition adds beyond the row into the menu', async function() {
    await driver.executeScript(INJECT, INJECTED);

    const narrow = await state(1280);

    expect(narrow.overflowPx, 'the row still overflows').to.be.at.most(1);
    expect(narrow.toggleHidden).to.be.false;
    expect(narrow.injectedInMenu).to.be.above(0);
    expect(narrow.injectedOnBar + narrow.injectedInMenu).to.equal(INJECTED);
  });

  it('keeps the action button on the row at every desktop width', async function() {
    for (const width of [769, 992, 1280, 1440, 1719, 1920]) {
      const measured = await state(width);

      expect(measured.ctaOnBar, `action button left the row at ${width}px`).to.be.true;
      expect(measured.overflowPx, `row overflows at ${width}px`).to.be.at.most(1);
      expect(measured.injectedOnBar + measured.injectedInMenu).to.equal(INJECTED);
    }
  });

  it('collapses further as the window narrows and gives the items back as it widens', async function() {
    const roomy = await state(1920);
    const tight = await state(992);
    const roomyAgain = await state(1920);

    expect(tight.menu.length).to.be.above(roomy.menu.length);
    expect(roomyAgain.menu.length).to.equal(roomy.menu.length);
    expect(roomyAgain.bar).to.deep.equal(roomy.bar);
  });

  it('hands every item back to the row once the bar stops being a row', async function() {
    const mobile = await state(500);

    expect(mobile.toggleHidden).to.be.true;
    expect(mobile.menu).to.be.empty;
    expect(mobile.injectedOnBar).to.equal(INJECTED);
  });

  /*
    An edition can hang a notification badge off an item, and the poll that
    switches it on runs long after the row was measured. A badge on a collapsed
    item is behind a closed menu, so the toggle has to carry the count itself
    or the notification is simply not delivered.
  */
  it('carries the count of a collapsed item\'s badge on the toggle', async function() {
    await state(992);

    const collapsed = await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      const item = document.querySelector('.nav-overflow-menu').lastElementChild;
      const badge = document.createElement('span');

      badge.className = 'label label-info notification-feature-badge';
      badge.textContent = '3';
      item.querySelector('a').appendChild(badge);

      window.requestAnimationFrame(function() {
        window.requestAnimationFrame(function() {
          const mark = document.querySelector('.nav-overflow-badge');
          done({marked: mark.classList.contains('is-visible'), text: mark.textContent});
        });
      });
    `);

    expect(collapsed.marked, 'the toggle did not pick the badge up').to.be.true;
    expect(collapsed.text).to.equal('3');

    // The poll hides the badge again once there is nothing left to report, and
    // a mark that outlives what it stands for is worse than no mark.
    const cleared = await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];

      document.querySelector('.nav-overflow-menu .notification-feature-badge')
        .classList.add('hidden');

      window.requestAnimationFrame(function() {
        const mark = document.querySelector('.nav-overflow-badge');
        done({marked: mark.classList.contains('is-visible')});
      });
    `);

    expect(cleared.marked).to.be.false;
  });
});
