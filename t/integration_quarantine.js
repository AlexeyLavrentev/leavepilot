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

module.exports = [
  {
    file: 'leave_type/leave_type_limit_in_action.js',
    failing: ['whole file'],
    reason: 'Hangs on the runner together with leave_type_limit_next_year.js, '
      + 'which shares its batch and its subject. Both pass locally in seconds.',
  },
  {
    file: 'leave_type/leave_type_limit_next_year.js',
    failing: ['And try to request one more day of the type already 100% taken'],
    reason: 'Hangs on the runner. Its chains now end in .catch(done) and the '
      + 'catch never fires, so nothing is rejecting: a wait genuinely never '
      + 'settles rather than an error being swallowed. It passed on the runner '
      + 'once, and its neighbour hangs in the same batch, which points at the '
      + 'two interacting through the shared server rather than at either alone. '
      + 'Needs a run with the browser visible.',
  },
];
