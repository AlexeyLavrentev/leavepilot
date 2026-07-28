# Bug Reproducer

## ✅ FIX_PROVEN — Bug reproduced and fix proven

> The same reproducer changed from failing to passing and broader checks passed.

**Project:** AlexeyLavrentev/timeoff  
**Bug:** Superseded leave forecast reappears after date invalidation  
**Environment:** Local Node.js application with Chrome Headless Shell 148  
**Generated:** 2026-07-28

## Discovery scope

- public/js/leave_forecast.js
- views/partials/book_leave_modal.hbs
- existing leave forecast and booking modal tests

## Ranked and tested candidates

| # | Candidate | Contract evidence | Trigger | Location | Confidence | Outcome |
|---:|---|---|---|---|---|---|
| 1 | A superseded forecast response can reappear after a required date is cleared | The client explicitly ignores superseded responses, and an invalid form state hides the forecast. | Start a forecast request, clear from_date, then resolve the old request. | /Users/aleksey/projects/timeoff-ui-accessibility/public/js/leave_forecast.js:86 | high | REPRODUCED |

## Original report

No bug was supplied. A read-only product audit identified a possible stale-response race in the New absence live balance forecast.

| Contract | Expected | Actual |
|---|---|---|
| Observed behavior | The forecast remains hidden after the required date is cleared. | The late response renders the old forecast and makes it visible again. |

## Minimal reproduction

A Selenium test replaces only the forecast AJAX transport with a controlled jQuery Deferred, starts a valid request, clears from_date, and resolves the superseded request.

**Confirming signal:** Expected forecast hidden=true after invalidation; received false.

### Reproduction files approved at Gate 1

- [leave_forecast_stale_response.js](/Users/aleksey/projects/timeoff-ui-accessibility/t/integration/leave_request/leave_forecast_stale_response.js:1) — Deterministic Selenium regression approved at Gate 1.

## Red to green evidence

| Evidence | Before fix | After fix |
|---|---:|---:|
| Exit code | 1 | 0 |
| Timed out | False | False |
| Duration | 3,000 ms | 3,017.502 ms |
| Same command | — | True |
| Broader suite | — | passed |

### Before — failing evidence

```text
Leave forecast stale-response handling
    ✔ creates an isolated company and opens the booking modal (1529ms)
    1) keeps a superseded forecast hidden after a required date is cleared
  1 passing (3s)
  1 failing
  1) Leave forecast stale-response handling
       keeps a superseded forecast hidden after a required date is cleared:
      a response superseded by clearing a required field must stay hidden
      + expected - actual
      -false
      +true
      at Context.<anonymous> (t/integration/leave_request/leave_forecast_stale_response.js:121:34)
```

### After — fixed evidence

```text
Leave forecast stale-response handling
    ✔ creates an isolated company and opens the booking modal (1463ms)
    ✔ keeps a superseded forecast hidden after a required date is cleared (937ms)
  2 passing (2s)
```

## Root cause

requestSeq advanced only when a debounced request had complete fields. Clearing a required field hid the forecast but did not invalidate an already-running request, so its completion still matched the current sequence and rendered.

## Approved fix

Advance the forecast generation synchronously on every relevant field change, hide the old result immediately, and pass that generation into the debounced request.

**Why this is causal:** Every response now carries the generation captured after its originating change. A later edit increments the generation before the old response can render, so the existing equality guard rejects it.

### Production files approved at Gate 2

- [leave_forecast.js](/Users/aleksey/projects/timeoff-ui-accessibility/public/js/leave_forecast.js:86) — Generation invalidation approved at Gate 2.

## Verification

| Check | Status | Evidence |
|---|---|---|
| Targeted stale-response regression | ✅ passed | Same command changed from exit 1 to exit 0; 2 passing. |
| Forecast and booking modal regressions | ✅ passed | 20 passing. |
| Full unit suite | ✅ passed | 888 passing. |

## Reproduce

```bash
rtk npx mocha t/integration/leave_request/leave_forecast_stale_response.js
```
```bash
rtk npx mocha t/unit/route/leave_balance_forecast.js t/integration/leave_request/book_leave_modal_focus.js t/integration/leave_request/book_leave_request_form.js
```
```bash
rtk npx mocha --recursive t/unit --timeout 10000
```

## Limitations

- The focused reproducer covers required-date invalidation while a request is pending.
- Network-error feedback and modal-dismissal lifecycle behavior were not changed in this fix.

## Residual risks

- Forecast network failures still hide the informational result without a visible error.
- The separate global single-click native-validation candidate remains untested.

## Notes

- No endpoint, payload, CSRF, debounce duration, backend validation, or booking behavior changed.
- Temporary test companies were removed through the application UI.

---

Generated by `$bug-reproducer`. A fix is proven only by the same red-to-green reproducer plus relevant broader checks.
