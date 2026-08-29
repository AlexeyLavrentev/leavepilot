'use strict';

const expect = require('chai').expect;
const path = require('path');
const setup = require('../../bin/browser_setup');

describe('browser setup', function() {
  const cacheRoot = path.join(process.cwd(), '.artifacts', 'verify', 'browser');

  it('pins Chrome-for-Testing and ChromeDriver to the verified build', function() {
    expect(setup.BUILD_ID).to.equal('152.0.7977.64');
  });

  it('keeps resolved executable paths below the repository cache root', function() {
    expect(setup.isWithinCache(cacheRoot, path.join(cacheRoot, 'chrome', 'chrome'))).to.equal(true);
    expect(setup.isWithinCache(cacheRoot, path.join(cacheRoot, '..', 'outside'))).to.equal(false);
  });

  it('requires matching browser and driver major versions', function() {
    expect(setup.haveMatchingMajorVersions('152.0.7977.64', '152.0.7977.64')).to.equal(true);
    expect(setup.haveMatchingMajorVersions('152.0.7977.64', '150.0.1.1')).to.equal(false);
    expect(setup.haveMatchingMajorVersions('not-a-version', '152.0.1.1')).to.equal(false);
  });

  it('names the bounded bootstrap command when the cache is missing', function() {
    expect(setup.missingPrerequisiteMessage()).to.equal(
      'browser setup missing; run: node bin/browser_setup.js --bootstrap'
    );
  });

  it('limits corrupt-download recovery to the pinned artifact name', function() {
    expect(setup.isPinnedArchiveName(`${setup.BUILD_ID}-chrome-mac-arm64.zip`)).to.equal(true);
    expect(setup.isPinnedArchiveName('150.0.1.1-chrome-mac-arm64.zip')).to.equal(false);
  });

  it('prints only the approved setup keys', function() {
    expect(Object.keys(setup.toPrintEnv({
      chromeBin: '/cache/chrome',
      chromedriverBin: '/cache/chromedriver',
      chromeVersion: '152.0.1.1',
      chromedriverVersion: '152.0.1.1',
      ignored: 'secret',
    })).sort()).to.deep.equal([
      'chromeBin',
      'chromeVersion',
      'chromedriverBin',
      'chromedriverVersion',
    ]);
  });
});
