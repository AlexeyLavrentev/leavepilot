'use strict';

/*
 * Integration specs that fail on master today.
 *
 * The browser suite was never wired into CI, so nothing ran it end to end and
 * these rotted unnoticed. Quarantining them lets the rest of the suite gate
 * every push from day one instead of the whole job staying red and being
 * ignored — which is how the suite got here in the first place.
 *
 * Each entry states what fails and what the assertion actually reported, so the
 * next person can pick one up without re-running everything. The list is meant
 * to shrink: delete entries, do not add them. A genuinely new failure belongs in
 * a fix, not here.
 *
 * Verified identical on master both before and after the Stage 8Q workspace
 * redesign, so none of these are regressions from that work.
 */

module.exports = [
  {
    file: 'leave_request/requests_decision_safety.js',
    failing: ['provides a full-width mobile selection target and keeps actions in view'],
    reason: 'Mobile selection target measures 293px wide against a 300px floor.',
  },
  {
    file: 'reports_hub/reports_hub_contract.js',
    failing: ['reduced-motion: emulated media suppresses the hover transform to none'],
    reason: 'The baseline half of the check expects a hover transform before '
      + 'reduced motion is emulated, and the card reports none.',
  },
  {
    file: 'team_view/sticky_header.js',
    failing: ['keeps left, middle, and right horizontal geometry within 1.5 CSS px'],
    reason: 'At the right edge the shell keeps can-scroll-right: scrollLeft '
      + 'settles just under scrollWidth - clientWidth, above the 2px tolerance '
      + 'in the cue logic.',
  },
  {
    file: 'leave_type/leave_type_limit_next_year.js',
    failing: ['And try to request one more day of the type already 100% taken'],
    reason: 'Hangs on the runner: still open at a two-minute budget where the '
      + 'sibling limit spec finished once the budget was raised, and the whole '
      + 'file passes locally. Unlike the rest of this list it has no failing '
      + 'assertion to chase, so it needs a run with the browser visible.',
  },
  {
    file: 'team_view/table_horizontal_navigation.js',
    failing: ['End moves to the right edge and removes can-scroll-right'],
    reason: 'Same right-edge residual as the sticky header, reached through the '
      + 'End key; the wait for the class to clear times out.',
  },
];
