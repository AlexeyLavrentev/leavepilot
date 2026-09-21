'use strict';

const fs = require('fs');
process.stdout.write('prerequisite-waiting\n');
const timer = setInterval(() => {
  if (fs.existsSync(process.env.STARTUP_TEST_RELEASE_FILE)) { clearInterval(timer); }
}, 20);
