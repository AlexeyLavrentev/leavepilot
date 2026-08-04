'use strict';

/*
  Two settings that are each valid alone and wrong together: TRUST_PROXY says TLS
  terminates in front of the app, while SESSION_COOKIE_SECURE stays at its
  default of false, so the session cookie goes out without the Secure attribute.

  Nothing caught it. lib/config.js hard-fails on a missing SESSION_SECRET or
  CRYPTO_SECRET, but session_cookie_secure is read in a separate loop with no
  failure path, config/app.json does not define it, and
  lib/middleware/withSession.js falls through to false.
*/

const expect = require('chai').expect;
const posture = require('../../lib/security_posture');

describe('Security posture warnings', function() {

  const settings = overrides => Object.assign({
    isProductionLike: true,
    trustProxy: '1',
    sessionCookieSecure: undefined,
  }, overrides);

  describe('session cookie', function() {

    it('warns when a trusted proxy is configured but the cookie is not Secure', function() {
      const message = posture.describeSessionCookieRisk(settings());

      expect(message).to.be.a('string');
      expect(message).to.include('SESSION_COOKIE_SECURE');
      expect(message).to.include('TRUST_PROXY');
    });

    it('stays quiet once the cookie is marked Secure', function() {
      ['true', '1', 'yes', 'on', true].forEach(value => {
        expect(
          posture.describeSessionCookieRisk(settings({sessionCookieSecure: value})),
          'accepted ' + value + ' should silence the warning'
        ).to.equal(null);
      });
    });

    /*
      Without a trusted proxy the app either serves TLS itself or serves plain
      HTTP directly. In the second case a Secure cookie is one the browser will
      not send at all, so its absence is not evidence of a mistake and warning
      would train the operator to ignore the log.
    */
    it('stays quiet when no proxy is trusted', function() {
      ['0', 'false', 'no', 'off', undefined, ''].forEach(value => {
        expect(
          posture.describeSessionCookieRisk(settings({trustProxy: value})),
          'trustProxy=' + value + ' should not warn'
        ).to.equal(null);
      });
    });

    it('stays quiet outside production', function() {
      expect(posture.describeSessionCookieRisk(settings({isProductionLike: false}))).to.equal(null);
    });
  });

  /*
    A warning that read these values differently from the code acting on them
    would be worse than no warning: it would fire on a correct deployment, or
    stay silent on a broken one.
  */
  describe('boolean parsing matches withSession', function() {

    const withSessionSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'lib', 'middleware', 'withSession.js'),
      'utf8'
    );

    it('accepts the same truthy spellings', function() {
      ['true', '1', 'yes', 'on'].forEach(value => {
        expect(posture.toBoolean(value, false), value).to.equal(true);
        expect(withSessionSource).to.include("'" + value + "'");
      });
    });

    it('accepts the same falsy spellings', function() {
      ['false', '0', 'no', 'off'].forEach(value => {
        expect(posture.toBoolean(value, true), value).to.equal(false);
        expect(withSessionSource).to.include("'" + value + "'");
      });
    });

    it('falls back for anything it does not recognise', function() {
      expect(posture.toBoolean('perhaps', false)).to.equal(false);
      expect(posture.toBoolean(undefined, true)).to.equal(true);
      expect(posture.toBoolean(null, false)).to.equal(false);
    });
  });

  describe('reporting', function() {

    it('writes each warning once, prefixed so it can be grepped', function() {
      const written = [];
      const warnings = posture.reportSecurityPosture(settings(), {warn: m => written.push(m)});

      expect(warnings).to.have.length(1);
      expect(written).to.have.length(1);
      expect(written[0]).to.match(/^security_posture: /);
    });

    it('writes nothing when there is nothing to say', function() {
      const written = [];
      const warnings = posture.reportSecurityPosture(
        settings({sessionCookieSecure: 'true'}),
        {warn: m => written.push(m)}
      );

      expect(warnings).to.deep.equal([]);
      expect(written).to.deep.equal([]);
    });
  });

  describe('wiring', function() {

    const configSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'lib', 'config.js'),
      'utf8'
    ).split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');

    it('runs at config load, where both settings are already resolved', function() {
      expect(configSource).to.include("require('./security_posture').reportSecurityPosture(");
      expect(configSource).to.include("trustProxy: nconf.get('trust_proxy')");
      expect(configSource).to.include("sessionCookieSecure: nconf.get('session_cookie_secure')");
    });
  });
});
