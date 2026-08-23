
'use strict';

const log = require('../lib/middleware/request_logger');

const
  {calculateCarryOverAllowance} = require('../lib/model/calculateCarryOverAllowance'),
  models = require('../lib/model/db');

models.User
  .findAll()
  .then(users =>calculateCarryOverAllowance({users}))
  .then(() => log.info('carry_over_calculation_done'))
  .catch(error => log.error(
    'carry_over_calculation_failed',
    { error: error && error.message, stack: error && error.stack }
  ));
