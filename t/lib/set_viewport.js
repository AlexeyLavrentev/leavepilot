'use strict';

/*
 * Size the viewport, not the window.
 *
 * `window().setRect()` sets the outer window, and how much of that the browser
 * chrome takes differs by host: the same call that leaves a 900px viewport on
 * one machine leaves 757 on another. Geometry contracts written against a
 * viewport then measure something else on CI.
 *
 * This measures the chrome and corrects for it, so the page really gets the
 * requested viewport wherever the suite runs.
 */

module.exports = async function setViewport(driver, {width, height}) {
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

  return driver.executeScript('return {width: window.innerWidth, height: window.innerHeight};');
};
