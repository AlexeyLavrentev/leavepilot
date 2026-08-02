'use strict';

/*
 * Integration specs excluded from the default browser run.
 *
 * The list is empty, and the goal is to keep it that way: it exists so a
 * genuinely stuck spec can be parked with a written reason instead of the whole
 * job going red and being ignored, which is how the suite rotted before it was
 * wired into CI at all.
 *
 * Each entry states the file, the failing test names and what the assertion
 * actually reported. `node bin/test.js --include-quarantined` runs them anyway.
 */

module.exports = [];
