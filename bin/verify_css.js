#!/usr/bin/env node
'use strict';

const {spawnSync} = require('child_process');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const build = spawnSync(npm, ['run', 'build-css'], {stdio: 'inherit'});
if (build.status !== 0) { process.exit(build.status || 1); }
const diff = spawnSync('git', ['diff', '--exit-code', '--', 'public/css/style.css'], {stdio: 'inherit'});
process.exit(diff.status || 0);
