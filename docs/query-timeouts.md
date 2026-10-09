# Query timeouts — issue #4, Phase 1

## Scope and implementation

The existing synchronous execution tools accept optional `queryTimeoutMs`. Omission
uses the configured default; longer caller values are allowed. Values are validated
against the driver's signed-integer seconds representation and rounded up to seconds.
Metadata/catalog tools retain their configured metadata timeout. Existing SQL access
restrictions, row caps, paging and tool permissions remain unchanged.

`executeStatement` creates a dedicated statement, sets `SQL_ATTR_QUERY_TIMEOUT`,
prepares and executes with bound parameters, collects result sets/output parameters,
then closes the cursor, statement and connection. The `ibm_db` prepared-statement
wrapper requires the same database back-reference assigned by its `Database.prepare`
helper. Explicit creation lets the timeout be set before preparation. This dependency
on the driver wrapper is covered by tests and should be rechecked when updating `ibm_db`.
The CLI macro is obtained from the module's CommonJS default export: Node's synthesized
ESM named exports include `open`, but not the dynamically copied `SQL_ATTR_QUERY_TIMEOUT`.
The compiled helper was also exercised with the actual installed module and stub statement
handles, without opening a database connection, to verify that module boundary.

No JavaScript execution `Promise.race` remains. We wait for the driver and cleanup;
we do not claim a hard wall-clock limit during network failures or cancellation/cleanup
delays. The driver login timeout is separately set to 10 seconds. Driver timeouts are
per statement, not an overall deadline for multi-statement tools.

## Local verification

Run `npm run build` and `npm test`. The mocked-driver tests cover:

- Attribute setup before prepare/execute; no untimed helper fallback.
- Long caller timeout and successful completion beyond the previous 30-second timer.
- Whole-second rounding, positive validation and representation limits.
- Scalar/directional binding, output parameters, multiple result sets and empty DDL results.
- Timeout versus ambiguous interruption diagnostics.
- Cleanup on setting, preparation, execution, fetching and result-advance failures.
- Timeout application to explain, metadata and health statements; no next statement after failure.
- MCP schema validation, default/override wiring and reported effective timeout across execution tools.

These tests prove application wiring and collection behavior against the inspected
driver API, **not that a live Db2 activity actually stops**.

## Required nonproduction integration proof

The October 9 live read-query comparison is recorded in
[Phase 1 nonproduction evidence](verification/issue-4-phase-1-nonprd-2026-10-09.md).
It verifies SQL interruption and cleanup, caller durations above 30 seconds, and
ordinary HTTP contracts against the current MCP. Live directional-output/multiple-result
procedure fixtures and long-query stdio transport remain untested; the local suite
covers their application logic, not their live database behavior.

Use an explicitly authorized nonproduction database and a DBA-approved read-only,
long-running fixture. Do not manufacture an unbounded cross join or invoke a production
procedure to test timeout handling. Confirm an independent operator/control path can
identify and stop the test activity if the driver timeout fails before beginning.

1. Record the Db2 server and CLI driver versions and effective driver configuration.
2. Run a bounded ordinary parameterized read and compare rows/paging with the old contract.
3. Run the approved long-read fixture with a short `queryTimeoutMs`. Record the requested
   and effective timeout, elapsed time and actual SQLSTATE/native diagnostic. Independently
   observe in Db2 that the owned activity ends and its connection is cleaned up. A timed-out
   MCP response alone is insufficient proof.
4. Run an approved read lasting longer than 30 seconds with a suitably longer caller timeout.
   Set the client's own request/proxy timeout accordingly; verify it completes successfully.
5. On synthetic nonproduction procedure fixtures only, compare multiple result sets and
   output parameters. Check timeout effects/transaction state explicitly where relevant;
   do not assume committed work is reversed.
6. Test HTTP and stdio callers used in practice. Confirm tool schema rediscovery exposes
   the new optional argument. Keep secrets, raw customer results and connection strings
   out of issue comments or logs.

No live database fixture is run by the default test suite. Do not describe local mocked
tests as live cancellation verification or deployment readiness.

## Sources and unresolved limits

- Inspected dependency: `ibm_db` 4.0.1, locked by `package-lock.json`.
- [Statement attribute API](https://github.com/ibmdb/node-ibm_db/blob/v4.0.1/APIDocumentation.md#-44-database-setattrsyncattributename-value).
- [Driver query/result/statement wrappers](https://github.com/ibmdb/node-ibm_db/blob/v4.0.1/lib/odbc.js).
- IBM Db2 Docs requests returned HTTP 403 during investigation. Installed-source
  evidence establishes the attribute API and resource ownership, but live timeout
  behavior, diagnostics and server-specific restrictions remain integration checks.

Live nonproduction testing found that CLI 12.01.0200 reports diagnostic SQLSTATE
`HY008` with native code -952 when the timeout interrupts a SQL read, while the
message contains server SQLSTATE 57014. Both states map to `DB_EXECUTION_INTERRUPTED`
without claiming the cause is necessarily a timeout. The external no-SQL
`SYSIBMADM.DBMS_ALERT.SLEEP` routine completed its five-second sleep despite a
one-second timeout; independent WLM cancellation was also observed only after the
sleep returned. Statement timeouts are not a force-termination guarantee for such routines.

Manual cancellation, operation registries, persistent results, queue/concurrency controls,
restart reconciliation and force termination are deliberately deferred to Phase 2.
