# Dialect-sensitive specs: the manifest

This is the human-readable description of the canonical inventory of spec
files whose subject matter behaves differently on SQLite and MySQL. The
machine-readable inventory lives in
[`t/fixtures/dialect-sensitive-specs.json`](../t/fixtures/dialect-sensitive-specs.json),
is consumed directly by the companion gate
[`t/unit/dialect_sensitive_manifest.js`](../t/unit/dialect_sensitive_manifest.js),
 and its `specs[].file` list doubles as the run list of the MySQL dialect
 CI job (phase 5, plan 05-05).

## Why this exists

An integration suite that only ever runs on SQLite proves nothing about
MySQL. The specs most likely to break on a second dialect are the ones
touching day calculation, date arithmetic, transactions and locking, and
raw SQL. Before any MySQL run existed, the whole tree was audited for
those signals and the result was fixed in the repository — **the audit
came BEFORE the companion test was written** (decision D-01, the same
grep-before-test convention as
[`docs/oem-leak-surfaces.md`](oem-leak-surfaces.md) in phase 4). The audit
method is recorded inside the manifest's `_comment` and is reproducible:
grep `t/` and `lib/` for six signal families — `sequelize.literal`, raw
`sequelize.query(`, `Op.between` / `BETWEEN ... AND` predicates, SQL date
functions (`DATEDIFF`, `DATE_ADD`, `DATE_SUB`, `DATE_FORMAT`,
`strftime`, `julianday`), `sequelize.transaction` / `.transaction(`, and
explicit timezone arithmetic (`moment-timezone`, `moment().tz('...')`).

## The four categories

Every entry is classified under exactly one of the locked categories
(a fifth category would be a visible manifest schema change and needs
owner review):

- **`day-calculation`** — specs exercising the leave day-count machinery:
  `get_days()` day-list expansion, `get_deducted_days()` filtering and
  half-day corrections, calendar-month day indexing
  (`lib/model/db/leave.js`, `lib/model/calendar_month.js`).
- **`date-arithmetic`** — specs exercising date-window and timezone
  arithmetic: overlap windows built from `moment.utc(...).endOf('day')`
  bounds against `DATE` columns, year-boundary prorating and carry-over
  (`lib/model/user_allowance.js`), company-timezone vs UTC boundaries,
  and the integration specs that pin dates with
  `moment().tz('Europe/London')`.
- **`locking-transactions`** — specs exercising code paths that run
  inside `sequelize.transaction` (`lib/route/departments.js`,
  `lib/model/company/remover.js`), whose atomicity and locking behaviour
  differs between SQLite and InnoDB.
- **`sql-literals`** — specs carrying raw SQL through
  `sequelize.query(...)` (backtick-quoted DDL, `INSERT`/`SELECT` on real
  tables, migration verification).

Where the dialect-sensitive thing is a `lib/` module rather than the spec
file itself, the entry names the module in its `module` field and in the
`reason`, and the companion gate verifies that module path — the manifest
lists specs, not modules.

## How the companion gate keeps it honest

A static list silently rots: a new dialect-sensitive spec added outside
the manifest would never run on MySQL, and the gate would stay green for
the wrong reason. So `t/unit/dialect_sensitive_manifest.js` re-derives
the grep-able half of the inventory from the code on every run:

1. **Re-derivation** — it scans every `.js` file under `t/` with the same
   conservative signal detectors the audit used. A spec showing signals
   but absent from the manifest fails the build, with the file and the
   matched signal named.
2. **Non-phantom** — every manifest entry's `file` must exist; entries
   whose signal lives in a lib module must name an existing `module`
   path.
3. **Teeth** — synthetic signal snippets (a raw query, a `BETWEEN`,
   a transaction call, a timezone pin, a `sequelize.literal`) are each
   flagged, and an ordinary model-calls-only snippet is not — proving
   the detector is neither blind nor trigger-happy.

The detector is deliberately conservative (known signal signatures
only): a false positive would force a pointless manifest entry.

## How to edit the manifest

When you add or touch a spec that carries one of the signals:

1. Add an entry to `specs[]` with `file`, `category` (one of the four
   locked names), a `reason` that names the actual signal found (quote
   the function or literal family, not a generic phrase), and — when the
   sensitivity lives in the module under test — the `module` path.
2. If a spec legitimately shows a signal but is NOT dialect-sensitive,
   say so in the entry's `reason` rather than leaving it out: the
   companion gate fails on any unlisted signal-carrier, so an entry with
   a justification is the only way to record the decision.
3. Reclassifying between categories is a `reason` edit; adding a fifth
   category is a schema change the owner reviews (D-01).

The companion gate fails the build if you forget — that is the point.
