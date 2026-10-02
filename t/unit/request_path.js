'use strict';

var expect = require('chai').expect;
var requestPath = require('../../lib/util/request_path');

describe('Safe request path', function() {
  it('removes query parameters from fallback request URLs', function() {
    expect(requestPath.getSafeRequestPath({
      originalUrl: '/login/sso/callback?code=secret-code&state=secret-state',
    })).to.equal('/login/sso/callback');
  });

  it('uses the query-free Express path when available', function() {
    expect(requestPath.getSafeRequestPath({
      path: '/login/sso/callback',
      originalUrl: '/login/sso/callback?code=secret-code',
    })).to.equal('/login/sso/callback');
  });

  it('returns null when no request path is available', function() {
    expect(requestPath.getSafeRequestPath()).to.equal(null);
    expect(requestPath.getSafeRequestPath({})).to.equal(null);
  });

  it('masks the feed bearer token segment before logging', function() {
    expect(requestPath.getSafeRequestPath({
      path: '/feed/1f0a9c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b/ical.ics',
    })).to.equal('/feed/[redacted]/ical.ics');
  });

  it('masks the token in fallback URLs together with the query string', function() {
    expect(requestPath.getSafeRequestPath({
      originalUrl: '/feed/some-feed-token/ical.ics?from=calendar-client',
    })).to.equal('/feed/[redacted]/ical.ics');
  });

  it('leaves non-feed paths untouched', function() {
    expect(requestPath.getSafeRequestPath({
      path: '/calendar/teamview/',
    })).to.equal('/calendar/teamview/');
  });
});
