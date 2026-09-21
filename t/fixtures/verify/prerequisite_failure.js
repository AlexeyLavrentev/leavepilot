'use strict';

process.stdout.write('probe began\n');
process.stderr.write('password=' + process.env.STARTUP_TEST_SECRET + '\n');
process.exitCode = 1;
