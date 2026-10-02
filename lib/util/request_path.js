'use strict';

function stripQueryString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const queryIndex = value.indexOf('?');
  return queryIndex === -1 ? value : value.slice(0, queryIndex);
}

const FEED_TOKEN_PATH = /(\/feed\/)?[^/]+(?=\/ical\.ics)/;

function getSafeRequestPath(req) {
  if (!req) {
    return null;
  }

  let path;
  if (typeof req.path === 'string') {
    path = req.path;
  } else {
    path = stripQueryString(req.originalUrl || req.url);
  }

  if (path === null) {
    return null;
  }

  // The iCal feed token is a live bearer credential carried in the URL path:
  // mask it before the path reaches any log line. The /feed/ mount prefix may
  // or may not be present depending on where in the Express 5 router the path
  // is captured, so both shapes are covered; /ical.ics is feed-only.
  return path.replace(FEED_TOKEN_PATH, '/feed/[redacted]');
}

module.exports = {
  getSafeRequestPath,
};
