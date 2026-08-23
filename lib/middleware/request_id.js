'use strict';

const crypto = require('crypto');
const logger = require('./request_logger');
const requestContext = require('./request_context');
const requestPath = require('../util/request_path');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const QUIET_PATH_PATTERN = /^(?:\/(?:css|js|fonts|images)\/|\/favicon(?:\.|\/))/;

function selectRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value)
    ? value
    : crypto.randomUUID();
}

function requestIdMiddleware(req, res, next) {
  const requestId = selectRequestId(req.headers['x-request-id']);
  const startTime = process.hrtime.bigint();

  req.requestId = requestId;
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  req.log = logger.child({ requestId });

  requestContext.run({ requestId }, () => {
    res.once('finish', function() {
      if (process.env.SILENCE_HTTP_LOGS === 'true') {return;}
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      const path = requestPath.getSafeRequestPath(req) || '';
      if (level !== 'info' || !QUIET_PATH_PATTERN.test(path)) {
        logger[level]('http_request', {
          method: req.method,
          path,
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs),
          ip: req.ip,
        });
      }
    });
    next();
  });
}

requestIdMiddleware.selectRequestId = selectRequestId;
requestIdMiddleware.REQUEST_ID_PATTERN = REQUEST_ID_PATTERN;

module.exports = requestIdMiddleware;
