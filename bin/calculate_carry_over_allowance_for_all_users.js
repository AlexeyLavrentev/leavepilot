
'use strict';

const log = require('../lib/middleware/request_logger');

const
  {calculateCarryOverAllowance} = require('../lib/model/calculateCarryOverAllowance'),
  models = require('../lib/model/db'),
  teamViewCache = require('../lib/cache/team_view_cache');

async function main() {
  let failed = false;
  try {
    const users = await models.User.findAll();
    await calculateCarryOverAllowance({users});
    log.info('carry_over_calculation_done');
  } catch (error) {
    failed = true;
    log.error(
      'carry_over_calculation_failed',
      { error: error && error.message, stack: error && error.stack }
    );
  } finally {
    // The carry-over adjustment mutates UserAllowanceAdjustment (a hooked
    // model), so the invalidation hooks may have opened the shared-store
    // cache client; close it alongside the database so this CLI never hangs
    // on a dangling Redis socket. The bounded drain first lets the deferred
    // user-hop resolvers (which query the database) finish before it closes.
    await new Promise(resolve => setTimeout(resolve, 400));
    await teamViewCache.close().catch(() => {});
    await models.sequelize.close().catch(() => {});
  }
  if (failed) {
    process.exit(1);
  }
}

main();
