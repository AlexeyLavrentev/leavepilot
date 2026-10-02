'use strict';

const log = require('../lib/middleware/request_logger');

const argv = require('minimist')(process.argv.slice(2));

const models = require('../lib/model/db');
const edition = require('../lib/edition');

// Bounded re-drive volume (D-11, T-04-12): ONE single pass over failed
// records — the CLI does not loop, does not wait for delivery, and does not
// reset attempts arbitrarily; re-drive semantics are exactly the worker's
// includeFailed claim path. --limit 0 is a deliberate no-op probe (claims
// nothing, exits 0); the ceiling keeps one manual invocation from
// stampeding the table past the task-lock-coordinated sweep.
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const requestedLimit = argv.limit === undefined
  ? DEFAULT_LIMIT
  : Number(argv.limit);

if (!Number.isInteger(requestedLimit) || requestedLimit < 0 || requestedLimit > MAX_LIMIT) {
  // Validation fails before any connection is opened, so there is nothing
  // to close — exit non-zero with a structured event only.
  log.error('delivery_redrive_failed', {
    reason : 'invalid_limit',
    limit  : argv.limit,
    min    : 0,
    max    : MAX_LIMIT,
  });
  process.exit(1);
}

models.connect()
  .then(function() {
    edition.initialize({ models: models });

    return edition.getRegistry().runSchedulerOnce('delivery-outbox', {
      models        : models,
      includeFailed : true,
      limit         : requestedLimit,
    });
  })
  .then(function(result) {
    // Counts only (MUT-02): ids and statuses never carry payload contents,
    // recipient addresses, or error texts.
    log.info('delivery_redrive_completed', {
      limit    : requestedLimit,
      skipped  : !!(result && result.skipped),
      claimed  : (result && result.claimed) || 0,
      delivered: (result && result.delivered) || 0,
      failed   : (result && result.failed) || 0,
    });
  })
  .then(function() {
    // No team-view cache close needed: the delivery worker never creates a
    // cache client (outbox rows are not an invalidation family).
    return models.sequelize.close();
  })
  .catch(function(error) {
    log.error('delivery_redrive_failed', {
      error: error && error.stack || String(error),
    });

    return models.sequelize.close()
      .catch(function() {})
      .then(function() {
        process.exit(1);
      });
  });
