'use strict';

/*
  Three small things, each of which had been true for a while and none of which
  anything would have noticed changing back.

  - Express advertised itself on every response.
  - A client asking for an API path that is not there got the HTML not-found
    page, which parses as neither JSON nor an error it can report.
  - The layout carried a Google Analytics snippet behind a config switch. The
    switch promised working analytics and could not deliver it: the snippet
    inserts a script from www.google-analytics.com, which script-src 'self' does
    not allow, and the property it names is a Universal Analytics one -
    Universal Analytics stopped processing data in July 2023. It also named the
    upstream project's property rather than this fork's, so anyone who turned it
    on was reporting to someone else.
*/

const expect = require('chai').expect;
const fs = require('fs');
const path = require('path');
const notFound = require('../../lib/middleware/not_found');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// Comments still contain what is being looked for, so an assertion that a
// string is gone has to ignore them.
const withoutComments = source => source
  .split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');

describe('Small surface', function() {

  describe('the server does not announce itself', function() {

    it('turns off the header express sends by default', function() {
      expect(withoutComments(read('app.js'))).to.include("app.disable('x-powered-by')");
    });

    it('turns it off before anything can answer a request', function() {
      const source = withoutComments(read('app.js'));

      expect(source.indexOf("app.disable('x-powered-by')")).to.be.below(
        source.indexOf('app.use('),
        'a response sent by middleware mounted earlier would still carry it'
      );
    });
  });

  describe('a path that is not there', function() {

    const respond = request => {
      const calls = [];
      const res = {
        status(code) { calls.push(['status', code]); return res; },
        json(body) { calls.push(['json', body]); return res; },
        render(view) { calls.push(['render', view]); return res; },
      };

      notFound(Object.assign({t: key => key}, request), res);

      return calls;
    };

    it('answers an API client in the shape its routers already use', function() {
      ['/api/v1/nope', '/api/reminder-schedules/17', '/api'].forEach(apiPath => {
        const calls = respond({path: apiPath});

        expect(calls[0], apiPath).to.deep.equal(['status', 404]);
        expect(calls[1][0], apiPath).to.equal('json');
        expect(calls[1][1], apiPath).to.have.property('error');
      });
    });

    /*
      Decided on the path rather than on Accept, so a browser that accepts
      anything at all still gets the page it asked for. Which also means the
      rule has to be a path boundary and not a prefix match.
    */
    it('still renders the page for everything else', function() {
      ['/calendar/typo', '/apitastic', '/', '/settings/general/nope'].forEach(pagePath => {
        const calls = respond({path: pagePath});

        expect(calls[0], pagePath).to.deep.equal(['status', 404]);
        expect(calls[1], pagePath).to.deep.equal(['render', 'not_found']);
      });
    });

    it('does not fall over without a translator', function() {
      const calls = respond({path: '/api/v1/nope', t: undefined});

      expect(calls[1][1].error).to.be.a('string');
    });
  });

  describe('the analytics snippet is gone', function() {

    it('is not in the layout', function() {
      expect(read('views/layouts/main.hbs')).to.not.match(/analytics/i);
    });

    it('leaves no helper behind for a template to call', function() {
      expect(withoutComments(read('lib/view/helpers.js'))).to.not.include('is_ga_analitics_on');
    });

    it('takes its switch with it, rather than leaving one that does nothing', function() {
      ['config/app.json', 'config/app.redis.json'].forEach(file => {
        const config = JSON.parse(read(file));

        expect(config, file).to.not.have.property('ga_analytics_on');
      });
    });

    it('ships no file for it', function() {
      expect(fs.existsSync(path.join(root, 'public', 'js', 'analytics.js'))).to.equal(false);
    });

    /*
      The property it named, UA-63733147-1, belongs to the upstream project.
      Worth asserting it is gone by its value rather than by its variable name:
      turning that switch on sent this fork's page views to someone else.
    */
    it('carries no tracking id anywhere', function() {
      ['views/layouts/main.hbs', 'lib/view/helpers.js', 'config/app.json']
        .forEach(file => expect(read(file), file).to.not.include('UA-63733147-1'));
    });
  });
});
