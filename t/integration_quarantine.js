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
    file: 'reports_hub/reports_hub_contract.js',
    failing: ['reduced-motion: emulated media suppresses the hover transform to none'],
    reason: 'The card elevation lives behind `@media (hover: hover)`, and the '
      + 'headless browser reports (hover: hover)=false and (pointer: fine)=false '
      + 'however real the synthetic pointer is. Emulating the pointer through '
      + '`Emulation.setEmulatedMedia` alongside reduced motion did not hold, so '
      + 'the media override needs a closer look than a drive-by fix.',
  },
  {
    file: 'leave_type/leave_type_limit_next_year.js',
    failing: ['And try to request one more day of the type already 100% taken'],
    reason: 'Hangs past a two-minute budget with no failing assertion while the '
      + 'whole file passes locally. It did pass once on the runner, in the run '
      + 'that proved the other viewport fixes, so it is timing-sensitive rather '
      + 'than broken; it needs a run with the browser visible.',
  },
];
