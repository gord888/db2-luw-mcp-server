# Issue #4 Phase 1 — live nonproduction comparison

Date: 2026-10-09. Scope: existing nonproduction Db2 database versus an isolated,
loopback-HTTP Phase 1 candidate. During the comparison, no deployment, database object
creation, business-data mutation, role change, commit, push or merge was performed.
Subsequent publication of these changes for PR review does not imply deployment.

## Identity and execution

- Both HTTP paths were independently verified to reach `UPGRADE` with the same database user.
- Current deployed MCP does not advertise `queryTimeoutMs`; the candidate does.
- Candidate is the local working tree on `gord888/issue-4-phase-1-timeouts`, based on
  main `d643a27be90c9be87cec8de3b528a10cb5a27fe5`, including the live-discovered `HY008` correction.
- Server: Db2 `11.5.9000.5318`; candidate CLI driver: `12.01.0200`; `ibm_db` package: `4.0.1`.
- Credentials were loaded privately from a restricted local file. No credentials or
  customer/business result rows were written to this evidence.
- Calls ran sequentially. A separate database connection observed each uniquely named
  test CTE through `MON_GET_ACTIVITY` and checked connection removal through `MON_GET_CONNECTION`.
- Independent `WLM_CANCEL_ACTIVITY` was exercised only on the explicitly captured handle,
  UOW and activity ID of an owned synthetic SQL test. It returned interruption in 136 ms;
  the activity and connection were absent after cleanup. No force termination was used.

## Ordinary contract comparisons

The following matched exactly after excluding the candidate's additive
`effectiveQueryTimeoutMs` field:

1. Database/user identity read.
2. Bound integer, string, boolean and null values (`42`, `synthetic`, `true`, `null`).
3. Ordered three-row synthetic paging with limit 1, offset 1, truncation and next offset.
4. Empty read result with an explicit 20-minute timeout.
5. The no-SQL built-in `SYSIBMADM.DBMS_ALERT.SLEEP(0)` procedure's empty result contract.

The candidate rejected a zero timeout through MCP input validation. These comparisons
were rerun after the diagnostic fix and passed.

## Timeout comparisons

The fixture produces bounded synthetic integers and a single aggregate row; it does
not read or change business tables. A unique CTE identifier identifies the owned activity
without SQL comments (the existing read-only classifier rejects comments).

```sql
WITH R_TEST(N) AS (
  VALUES 1
  UNION ALL
  SELECT N + 1 FROM R_TEST WHERE N < 60000000
)
SELECT SUM(BIGINT(N)) AS TOTAL FROM R_TEST
```

The small variant uses 5,000,000 iterations. The independent watchdog was 12 seconds
for the small fixture and 50 seconds for the long fixture, with cancellation restricted
to the exact owned activity if required. No watchdog cancellation was needed.

| Case | Current MCP | Phase 1 candidate | Database readback |
|---|---|---|---|
| Small SQL, requested 1,000 ms | Completed in 3,256 ms; caller override unsupported | Interrupted in 2,118 ms, `HY008` / native -952 | Owned activity ended and connection removed |
| Long SQL, requested 45,000 ms | Returned `DB_TIMEOUT` in 30,016 ms | Completed successfully in 41,672 ms, reported effective timeout 45,000 ms | Current activity still active at 30,257 ms **after** its response; eventually ended naturally. Candidate activity ended and connection removed |
| Long SQL, timeout omitted | Existing default is 30 seconds | Interrupted in 30,199 ms using the 30-second default | Candidate activity ended and connection removed |

The successful long-query result was `1800000030000000`, exactly
`60000000 * 60000001 / 2`. The long comparison ran from 17:59:03.083Z to
18:00:55.047Z. This proves the candidate is not capped at 30 seconds and shows that
the existing application timeout does not stop its SQL activity.

The current response and underlying database completion are deliberately reported
separately. Monitoring was continued until its activity ended and connection disappeared.
There was no retry of an ambiguous write; all SQL fixtures were read-only.

## Live discoveries and correction

1. **Driver diagnostics:** the CLI's structured SQLSTATE was `HY008` with native -952,
   although the message contained server SQLSTATE 57014. Initially this became a generic
   execution error. The candidate now handles both `HY008` and `57014` as
   `DB_EXECUTION_INTERRUPTED`, without claiming the cause can always be distinguished
   from external cancellation. A regression was added and the live small/default
   timeout cases passed after correction.
2. **Not a precise wall-clock limit:** a requested one-second timeout returned after
   approximately 2.1 seconds. Driver interruption/polling and cleanup affect elapsed time.
3. **External routines are not reliably interruptible:** a bounded five-second
   `DBMS_ALERT.SLEEP` (catalogued as no SQL) completed successfully despite a one-second
   statement timeout. Independent WLM cancellation was observed only after the five-second
   sleep returned (5,016 ms). This is a real limitation, not a passing timeout test.
   Phase 1 does not promise force termination of such routines.

## Final checks and remaining scope

- Final independent query found no remaining activities with the test CTE marker.
- All captured operation connections were absent after each cleanup check.
- `npm test`: **105 passed across 12 files**, including browser E2E.
- `npm run build`: passed. `git diff --check`: passed.
- Original machine-readable evidence remains in task-scoped `/tmp/opencode/db2-phase1-*.json`
  files with owner-only permissions; this maintained document preserves the useful results.
- Live directional-output/multiple-result procedure fixtures, long-query stdio transport,
  arbitrary external-routine interruption, network failure, restart/concurrency behavior
  and force termination were not proven. Local procedure/result logic has mocked coverage.
- The current nonproduction MCP was not changed. Production was not contacted.
- Phase 2 asynchronous handles, manual cancellation and permission-controlled force
  termination remain separate work. Issue #4 remains open.
