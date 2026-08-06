'use strict';

/*
 * Size the viewport, not the window.
 *
 * `window().setRect()` sets the outer window, which is the wrong instrument
 * twice over.
 *
 * How much of the window the browser chrome takes differs by host: the same
 * call that leaves a 900px viewport on one machine leaves 757 on another.
 *
 * And a window has a minimum size. Chrome on macOS will not go narrower than
 * about 500px, so `setRect({width: 390})` leaves a 500px viewport and says
 * nothing about it. Measured on this host: 1440 asked, 1440 given; 768 asked,
 * 768 given; 390 asked, 500 given. Every mobile contract in the suite was
 * therefore measuring a desktop-width viewport while claiming to measure a
 * phone, and the same specs measured a real 390 on Linux CI - which is one of
 * the ways a suite comes to behave differently on a developer's machine than in
 * CI for reasons nobody can see.
 *
 * So: ask for the window, measure what the page actually got, and fall back to
 * the device metrics override when the window could not deliver. That sets the
 * layout viewport directly and is not bound by the window's minimum. If neither
 * works this throws, because a geometry contract that quietly measures a
 * different viewport than the one it names is worse than a failing one.
 */

const asDeviceMetrics = ({width, height}) => ({
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
});

const measure = driver => driver.executeScript(
  'return {width: window.innerWidth, height: window.innerHeight};'
);

const supportsOverride = driver => typeof driver.sendDevToolsCommand === 'function';

/*
  Cleared before every sizing rather than left in place: an override pins the
  viewport, so a spec stepping 390 -> 1440 would otherwise keep measuring 390
  with no way to notice.
*/
const clearOverride = async driver => {
  if (!supportsOverride(driver)) {
    return;
  }

  try {
    await driver.sendDevToolsCommand('Emulation.clearDeviceMetricsOverride', {});
  } catch (error) {
    // Nothing to clear is the ordinary case.
  }
};

module.exports = async function setViewport(driver, {width, height}) {
  await clearOverride(driver);
  await driver.manage().window().setRect({width, height});

  const chrome = await driver.executeScript(
    'return [window.outerWidth - window.innerWidth, window.outerHeight - window.innerHeight];'
  );

  if (chrome[0] || chrome[1]) {
    await driver.manage().window().setRect({
      width: width + chrome[0],
      height: height + chrome[1],
    });
  }

  let actual = await measure(driver);

  if ((actual.width !== width || actual.height !== height) && supportsOverride(driver)) {
    await driver.sendDevToolsCommand(
      'Emulation.setDeviceMetricsOverride',
      asDeviceMetrics({width, height})
    );

    actual = await measure(driver);
  }

  if (actual.width !== width || actual.height !== height) {
    throw new Error(
      'Could not give the page a ' + width + 'x' + height + ' viewport; it got '
      + actual.width + 'x' + actual.height + '. A geometry contract measured '
      + 'against a viewport it did not ask for is worse than a failing one.'
    );
  }

  return actual;
};
