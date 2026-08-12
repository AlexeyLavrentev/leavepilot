'use strict';

const fs = require('fs');
const path = require('path');

const envResolver = require('../env_resolver');

const COMMERCIAL_MARKER_PATH = path.resolve(__dirname, '..', '..', '.timeoff-commercial');

const isCommercialEdition = () => (
  fs.existsSync(COMMERCIAL_MARKER_PATH)
  || envResolver.resolve('EDITION') === 'commercial'
);

module.exports = {
  COMMERCIAL_MARKER_PATH,
  isCommercialEdition,
};
