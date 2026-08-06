'use strict';

/*
  Specs that measure geometry ask for a viewport. What they had was setRect on
  the window, and a window is not a viewport - twice over.

  Chrome takes some of the window: measured on this host, a 1024x768 window
  leaves a 1024x625 page. The suite's login helper sized the window that way, so
  three specs asserted "desktop viewport 1024x768", read the window back, saw
  1024x768 and passed - while the page they were measuring was 625px tall.

  And a window has a minimum size. Chrome on macOS will not go narrower than
  about 500px: asked for 390 it gives 500, and says nothing. Every mobile
  contract in the suite was measuring a 500px page and calling it a phone. On
  Linux CI the same call gives a real 390, which is how this stayed invisible -
  the specs behaved differently on a developer's machine than in CI, for a
  reason nothing reported.

  The helper now measures what the page actually got and falls back to the
  device metrics override, which sets the layout viewport directly and is not
  bound by the window. If it still cannot deliver it throws, because a contract
  that quietly measures a viewport it did not ask for is worse than a failing
  one.

  Driven through a fake driver here: the decisions are what matter and a real
  browser cannot be asked to have a particular minimum window size on demand.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');
const setViewport = require('../lib/set_viewport');

const CHROME_QUERY = 'outerWidth';

/*
  `clamp` stands in for the host: it decides what the page gets for a window of
  a given size, which is the thing that differs between machines.
*/
const fakeDriver = ({clamp, chrome = [0, 0], canOverride = true}) => {
  const calls = [];
  let page = {width: 0, height: 0};

  const driver = {
    calls,
    manage: () => ({
      window: () => ({
        setRect: async rect => {
          calls.push(['setRect', rect]);
          page = clamp(rect);
        },
      }),
    }),
    executeScript: async script => (
      script.indexOf(CHROME_QUERY) !== -1 ? chrome : page
    ),
  };

  if (canOverride) {
    driver.sendDevToolsCommand = async (command, params) => {
      calls.push([command, params]);

      if (command === 'Emulation.setDeviceMetricsOverride') {
        page = {width: params.width, height: params.height};
      }
    };
  }

  return driver;
};

const commandsIn = driver => driver.calls.map(call => call[0]);

describe('Sizing the viewport', function() {

  describe('when the window can deliver it', function() {

    const exact = rect => ({width: rect.width, height: rect.height});

    it('returns the viewport that was asked for', async function() {
      const driver = fakeDriver({clamp: exact});

      expect(await setViewport(driver, {width: 1440, height: 900}))
        .to.deep.equal({width: 1440, height: 900});
    });

    it('does not reach for the override', async function() {
      const driver = fakeDriver({clamp: exact});

      await setViewport(driver, {width: 1440, height: 900});

      expect(commandsIn(driver)).to.not.include('Emulation.setDeviceMetricsOverride');
    });
  });

  /*
    The case that was making three specs measure a 625px page while asserting
    768: the window is the size that was asked for and the page is smaller.
  */
  describe('when the browser takes part of the window', function() {

    const withChrome = [0, 143];
    const clamp = rect => ({width: rect.width, height: rect.height - 143});

    it('gives the page the size that was asked for, not the window', async function() {
      const driver = fakeDriver({clamp, chrome: withChrome});

      expect(await setViewport(driver, {width: 1024, height: 768}))
        .to.deep.equal({width: 1024, height: 768});
    });

    it('grows the window by what the browser takes', async function() {
      const driver = fakeDriver({clamp, chrome: withChrome});

      await setViewport(driver, {width: 1024, height: 768});

      const rects = driver.calls.filter(call => call[0] === 'setRect').map(call => call[1]);

      expect(rects[rects.length - 1]).to.deep.equal({width: 1024, height: 911});
    });
  });

  /*
    Chrome on macOS will not make a window narrower than about 500px. Asked for
    390 it gives 500 and reports nothing, so the request has to be met another
    way or not claimed at all.
  */
  describe('when the window has a minimum it will not go below', function() {

    const clamp = rect => ({width: Math.max(rect.width, 500), height: rect.height});

    it('still gives the page the viewport that was asked for', async function() {
      const driver = fakeDriver({clamp});

      expect(await setViewport(driver, {width: 390, height: 844}))
        .to.deep.equal({width: 390, height: 844});
    });

    it('gets there with the device metrics override', async function() {
      const driver = fakeDriver({clamp});

      await setViewport(driver, {width: 390, height: 844});

      expect(commandsIn(driver)).to.include('Emulation.setDeviceMetricsOverride');
    });

    /*
      An override pins the viewport, so a spec stepping 390 -> 1440 would keep
      measuring 390 with no way to notice. Cleared before every sizing rather
      than after, because a spec that throws mid-way would otherwise leave it on
      for whatever runs next.
    */
    it('clears any previous override before sizing', async function() {
      const driver = fakeDriver({clamp});

      await setViewport(driver, {width: 390, height: 844});

      expect(commandsIn(driver)[0]).to.equal('Emulation.clearDeviceMetricsOverride');
    });

    it('says so rather than measuring something else, when it cannot', async function() {
      const driver = fakeDriver({clamp, canOverride: false});
      let raised = null;

      try {
        await setViewport(driver, {width: 390, height: 844});
      } catch (error) {
        raised = error;
      }

      expect(raised, 'a viewport it could not deliver was reported as delivered').to.be.an('error');
      expect(raised.message).to.contain('390x844');
      expect(raised.message).to.contain('500x844');
    });
  });

  /*
    The helper is only worth having if it is the way the suite sizes anything.
    Twenty spec files sized the window directly - sixteen of them through a
    local wrapper of their own, reinvented file by file - which is how the
    shared helper ended up with three users and the fix never reached them.
  */
  describe('nothing sizes the window on its own', function() {

    const collect = directory => fs.readdirSync(directory, {withFileTypes: true})
      .reduce((files, entry) => {
        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
          return files.concat(collect(entryPath));
        }

        return entry.name.endsWith('.js') ? files.concat(entryPath) : files;
      }, []);

    it('outside the helper itself', function() {
      const root = path.join(__dirname, '..');
      const helper = path.join(root, 'lib', 'set_viewport.js');

      // Assembled rather than written out, so this file does not match itself.
      const sizesTheWindow = 'window().set' + 'Rect(';

      const offenders = collect(root)
        .filter(file => file !== helper)
        .filter(file => fs.readFileSync(file, 'utf8').indexOf(sizesTheWindow) !== -1)
        .map(file => path.relative(root, file));

      expect(offenders).to.deep.equal([]);
    });
  });
});
