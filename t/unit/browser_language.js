'use strict';

/*
  The browser suite asserts English strings - "New company" on the registration
  page, "Login" on the sign-in one - so the browser's language is part of the
  contract those specs are written against. Nothing pinned it, so it came from
  whoever was running them.

  CI's Chrome negotiates English, so CI was fine. On a machine whose Chrome asks
  for Russian, the application answers in Russian and every browser spec fails at
  its first assertion:

    AssertionError: Expected registration page at http://127.0.0.1:3301/register/:
      expected 'Новая компания' to equal 'New company'

  Eleven failures out of eleven in one file, and the same everywhere else, which
  reads as the suite being broken on that machine rather than as a language
  mismatch - and reading it that way is how the browser suite came to be treated
  as a CI-only check, with local runs written off. With the language pinned the
  same file passes ten of ten in six seconds.

  Asserted against the options object rather than the source text or a running
  browser: this is what Chrome will actually be told, and it costs nothing to
  ask.
*/

const expect = require('chai').expect;
const fs = require('fs');
const { buildOptions } = require('../lib/build_driver');

describe('The browser the suite drives', function() {

  const chromeOptions = () => buildOptions().get('goog:chromeOptions');

  it('asks for an English interface', function() {
    const args = chromeOptions().args || [];

    expect(args).to.include('--lang=en-US');
  });

  /*
    The two are not interchangeable. --lang sets the browser's own UI language;
    the preference sets the Accept-Language header, and the header is what the
    application negotiates on. Pinning only the first leaves the specs reading
    whatever the host asks for.
  */
  it('asks the server for English too', function() {
    const prefs = chromeOptions().prefs || {};

    expect(prefs['intl.accept_languages']).to.be.a(
      'string',
      'the UI language is pinned but the Accept-Language header is not'
    );
    expect(prefs['intl.accept_languages']).to.match(/^en\b/);
  });

  // Not a headless concern, and specs run with SHOW_CHROME set have the same
  // assertions to satisfy.
  it('pins it whether or not the run is headless', function() {
    const withHead = process.env.SHOW_CHROME;

    process.env.SHOW_CHROME = '1';

    try {
      const args = chromeOptions().args || [];

      expect(args).to.include('--lang=en-US');
      expect(args).to.not.include('--headless=new', 'the fixture did not take effect');
    } finally {
      if (withHead === undefined) {
        delete process.env.SHOW_CHROME;
      } else {
        process.env.SHOW_CHROME = withHead;
      }
    }
  });

  /*
    puppeteer.executablePath() answered this until puppeteer 25 made it return
    a promise. It did not announce the change: fs.existsSync of a promise is
    false rather than a throw, so the branch stopped finding anything and
    resolution fell through to chrome-headless-shell - a different binary from
    the Chrome these specs are written against, and nothing would have said so.
  */
  describe('the browser it is pointed at', function() {

    it('is a real Chrome, not the headless shell', function() {
      const binary = chromeOptions().binary;

      if (!binary) {
        return this.skip();   // selenium finds its own; nothing to assert
      }

      expect(binary).to.not.match(
        /chrome-headless-shell/,
        'resolution fell through to the shell, which is not what the geometry contracts measure'
      );
    });

    it('resolves to a path that exists', function() {
      const binary = chromeOptions().binary;

      if (!binary) {
        return this.skip();
      }

      expect(fs.existsSync(binary), binary + ' does not exist').to.equal(true);
    });

    // The resolver has to stay synchronous: fifty-odd specs build a driver from
    // it and none of them can await.
    it('is resolved synchronously', function() {
      const binary = chromeOptions().binary;

      expect(binary === null || typeof binary === 'string').to.equal(
        true,
        'the binary arrived as a ' + (binary && binary.constructor && binary.constructor.name)
      );
    });
  });

  it('still carries the settings the layout contracts depend on', function() {
    const args = chromeOptions().args || [];

    expect(args).to.include('--hide-scrollbars');
    expect(args.some(argument => /primaryHoverType=2/.test(argument))).to.equal(true);
  });
});
