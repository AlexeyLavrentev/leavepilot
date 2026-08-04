'use strict';

/*
  Four stylesheets and scripts used to be pushed onto every response. Three of
  them exist for the booking modal and the authenticated forms, so a logged-out
  visitor downloaded 53KB of date-picker script and a 30KB stylesheet that
  nothing on their page could use.

  The gate is req.user, so the risk runs the other way too: an authenticated
  page that quietly stops linking the date picker breaks every date field on it,
  and no unit test would notice. Both directions are asserted here.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');
const pageAssets = require('../../lib/middleware/page_assets');

describe('Page assets', function() {

  const run = req => {
    const res = {locals: {}};
    let called = false;

    pageAssets.attachPageAssets(req, res, function() { called = true; });

    expect(called, 'the middleware did not call next()').to.equal(true);

    return res.locals;
  };

  describe('signed out', function() {

    const locals = () => run({});

    it('links nothing but the script every page needs', function() {
      expect(locals().custom_java_script).to.deep.equal([pageAssets.GLOBAL_SCRIPT]);
    });

    it('links no stylesheet of its own', function() {
      expect(locals().custom_css).to.deep.equal([]);
    });

    it('does not ship the date picker to somebody who cannot use it', function() {
      const {custom_java_script, custom_css} = locals();

      expect(custom_java_script).to.not.include(pageAssets.DATE_PICKER_SCRIPT);
      expect(custom_java_script).to.not.include(pageAssets.LEAVE_FORECAST_SCRIPT);
      expect(custom_css).to.not.include(pageAssets.DATE_PICKER_STYLESHEET);
    });
  });

  describe('signed in', function() {

    const locals = () => run({user: {id: 1}});

    it('still links everything the booking forms need', function() {
      const {custom_java_script, custom_css} = locals();

      expect(custom_java_script).to.include(pageAssets.DATE_PICKER_SCRIPT);
      expect(custom_java_script).to.include(pageAssets.GLOBAL_SCRIPT);
      expect(custom_java_script).to.include(pageAssets.LEAVE_FORECAST_SCRIPT);
      expect(custom_css).to.include(pageAssets.DATE_PICKER_STYLESHEET);
    });

    /*
      leave_forecast reaches for the date picker as it initialises, so parse
      order is load-bearing rather than cosmetic.
    */
    it('parses the date picker before the code that reaches for it', function() {
      const scripts = locals().custom_java_script;

      expect(scripts.indexOf(pageAssets.DATE_PICKER_SCRIPT))
        .to.be.below(scripts.indexOf(pageAssets.LEAVE_FORECAST_SCRIPT));
      expect(scripts.indexOf(pageAssets.DATE_PICKER_SCRIPT)).to.equal(0);
    });
  });

  describe('contract with the routes that push onto these', function() {

    it('always leaves both as arrays', function() {
      // A dozen routes call custom_java_script.push(...) with no guard.
      [{}, {user: {id: 1}}].forEach(req => {
        const {custom_java_script, custom_css} = run(req);

        expect(custom_java_script).to.be.an('array');
        expect(custom_css).to.be.an('array');
      });
    });

    it('gives each request its own arrays', function() {
      const first = run({user: {id: 1}});
      const second = run({user: {id: 2}});

      first.custom_java_script.push('/js/leaked.js');

      expect(second.custom_java_script).to.not.include(
        '/js/leaked.js',
        'one request pushing an asset changed what another request links'
      );
    });
  });

  describe('the booking modal follows the same gate', function() {

    const footer = fs.readFileSync(
      path.join(__dirname, '..', '..', 'views', 'partials', 'footer.hbs'),
      'utf8'
    );

    it('renders the modal only for a logged-in user', function() {
      const guard = footer.indexOf('{{#if logged_user}}');
      const modal = footer.indexOf('book_leave_modal');

      expect(guard, 'the footer renders the booking modal unconditionally').to.be.above(-1);
      expect(guard).to.be.below(modal);
      expect(footer.indexOf('{{/if}}')).to.be.above(modal);
    });
  });
});
