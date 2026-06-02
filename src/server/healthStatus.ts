import type { Db2Client, Db2ClientFactory, Db2Parameter } from '../db2/Db2Client.js';
import { toAppError } from '../errors/errorMapper.js';
import {
  type AccessMode,
  type ResolvedConfig,
  type ToolName,
  getToolsForMode
} from '../config/types.js';

const BASIC_SELECT_HEALTH_SQL = 'SELECT CURRENT TIMESTAMP AS CURRENT_TIMESTAMP FROM SYSIBM.SYSDUMMY1 WITH UR';
const PROCEDURE_ACCESS_PROBE_COMMAND = 'CALL SYSPROC.GET_DBSIZE_INFO(?, ?, ?, -1)';
const FULL_CREATE_PROCEDURE_COMMAND = 'CREATE OR REPLACE PROCEDURE DB2MCP_HEALTH_PROBE() LANGUAGE SQL BEGIN DECLARE HEALTHCHECK_VALUE INTEGER DEFAULT 4242; END';
const DEFAULT_RUNTIME_ENV_FILE = '/etc/db2-luw-mcp-server.env';
const DEFAULT_SYSTEMD_UNIT = '/etc/systemd/system/db2-luw-mcp-server.service';
const DEFAULT_SERVICE_NAME = 'db2-luw-mcp-server';
const PROCEDURE_ACCESS_PROBE: { schema: string; name: string; params: Db2Parameter[] } = {
  schema: 'SYSPROC',
  name: 'GET_DBSIZE_INFO',
  params: [
    { direction: 'output', value: '', sqlType: 'TIMESTAMP', length: 30 },
    { direction: 'output', value: '', length: 30 },
    { direction: 'output', value: '', length: 30 },
    { direction: 'input', value: -1, sqlType: 'INTEGER' }
  ]
};

export interface ProfileHealthCheck {
  label: string;
  command: string;
  checkedAt: string;
  status: 'ok' | 'error' | 'skipped';
  detail?: string;
  skippedReason?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface ServiceHealthSummary {
  checkedAt: string;
  status: 'ok' | 'degraded';
  workingDirectory: string;
  mode: AccessMode;
  callerLabel: string;
  dbLabel: string;
  tools: ToolName[];
  toolCount: number;
  procedureAllowlist: string[];
  publicBaseUrl?: string;
  fileLocations: {
    workingDirectory: string;
    runtimeEnvFile: string;
    systemdUnit: string;
    serviceName: string;
    descriptorFiles: string[];
  };
  basicSelect: {
    sql: string;
    checkedAt: string;
    status: 'ok' | 'error' | 'skipped';
    currentTimestamp?: string;
    skippedReason?: string;
    error?: {
      code: string;
      message: string;
    };
  };
  checks: ProfileHealthCheck[];
  notes: string[];
}

export interface HealthSummaryOptions {
  includeDetailedChecks?: boolean;
}

function extractCurrentTimestamp(rows: Array<Record<string, unknown>>): string | undefined {
  const firstRow = rows[0];
  if (!firstRow) {
    return undefined;
  }
  const candidate = firstRow.CURRENT_TIMESTAMP ?? firstRow.current_timestamp ?? Object.values(firstRow)[0];
  return candidate === undefined ? undefined : String(candidate);
}

export async function collectServiceHealthSummary(
  config: ResolvedConfig,
  db2ClientFactory: Db2ClientFactory,
  options: HealthSummaryOptions = {}
): Promise<ServiceHealthSummary> {
  const checkedAt = new Date().toISOString();
  const client = db2ClientFactory.create(config);
  const checks: ProfileHealthCheck[] = [];
  const notes: string[] = [];

  let basicSelectStatus: 'ok' | 'error' = 'ok';
  let currentTimestamp: string | undefined;
  let basicSelectError: { code: string; message: string } | undefined;

  try {
    const result = await client.query(BASIC_SELECT_HEALTH_SQL, [], {
      timeoutMs: config.limits.metadataTimeoutMs,
      label: 'health_basic_select'
    });
    currentTimestamp = extractCurrentTimestamp(result.rows);
  } catch (error) {
    basicSelectStatus = 'error';
    const appError = toAppError(error);
    basicSelectError = { code: appError.code, message: appError.message };
  }

  if (config.mode === 'readonly_procedures' || config.mode === 'full') {
    const hasGetDbsizeInfo = config.procedureAllowlist.some(
      (entry) => entry.schema.toUpperCase() === 'SYSPROC' && entry.name.toUpperCase() === 'GET_DBSIZE_INFO'
    );
    const canCallProcedures = config.mode === 'full' || hasGetDbsizeInfo;

    let procedureStatus: 'ok' | 'error' | 'skipped' = 'skipped';
    let procedureSkippedReason: string | undefined;
    let procedureError: { code: string; message: string } | undefined;

    if (canCallProcedures) {
      try {
        await client.callProcedure(PROCEDURE_ACCESS_PROBE.schema, PROCEDURE_ACCESS_PROBE.name, PROCEDURE_ACCESS_PROBE.params, {
          timeoutMs: config.limits.queryTimeoutMs,
          label: 'health_procedure_probe'
        });
        procedureStatus = 'ok';
      } catch (error) {
        procedureStatus = 'error';
        const appError = toAppError(error);
        procedureError = { code: appError.code, message: appError.message };
      }
    } else {
      procedureSkippedReason = 'SYSPROC.GET_DBSIZE_INFO is not in the procedure allowlist.';
    }

    checks.push({
      label: 'Stored procedure probe',
      command: PROCEDURE_ACCESS_PROBE_COMMAND,
      checkedAt,
      status: procedureStatus,
      skippedReason: procedureSkippedReason,
      error: procedureError,
      detail: procedureStatus === 'ok' ? 'Stored procedure call succeeded.' : undefined
    });
  }

  if (config.mode === 'full' && options.includeDetailedChecks) {
    let createProcStatus: 'ok' | 'error' = 'ok';
    let createProcError: { code: string; message: string } | undefined;

    try {
      await client.query(FULL_CREATE_PROCEDURE_COMMAND, [], {
        timeoutMs: config.limits.queryTimeoutMs,
        label: 'health_create_procedure_probe'
      });
    } catch (error) {
      createProcStatus = 'error';
      const appError = toAppError(error);
      createProcError = { code: appError.code, message: appError.message };
    }

    checks.push({
      label: 'Create or replace procedure probe',
      command: FULL_CREATE_PROCEDURE_COMMAND,
      checkedAt,
      status: createProcStatus,
      error: createProcError,
      detail: createProcStatus === 'ok' ? 'Create or replace procedure succeeded.' : undefined
    });
  }

  await client.close();

  const overallStatus = basicSelectStatus === 'ok'
    && checks.every((check) => check.status !== 'error') ? 'ok' : 'degraded';

  return {
    checkedAt,
    status: overallStatus,
    workingDirectory: process.cwd(),
    mode: config.mode,
    callerLabel: config.callerLabel,
    dbLabel: config.dbLabel,
    tools: config.tools,
    toolCount: config.tools.length,
    procedureAllowlist: config.procedureAllowlist.map((entry) => `${entry.schema}.${entry.name}`),
    publicBaseUrl: config.server.publicBaseUrl,
    fileLocations: {
      workingDirectory: process.cwd(),
      runtimeEnvFile: DEFAULT_RUNTIME_ENV_FILE,
      systemdUnit: DEFAULT_SYSTEMD_UNIT,
      serviceName: DEFAULT_SERVICE_NAME,
      descriptorFiles: config.descriptorFiles
    },
    basicSelect: {
      sql: BASIC_SELECT_HEALTH_SQL,
      checkedAt,
      status: basicSelectStatus,
      currentTimestamp,
      error: basicSelectError
    },
    checks,
    notes
  };
}

export function renderStatusPage(summary: ServiceHealthSummary): string {
  const otherModes: Array<{ id: string; mode: AccessMode; tools: ToolName[] }> = [
    { id: 'readonly', mode: 'readonly' as AccessMode, tools: getToolsForMode('readonly') },
    { id: 'readonly_procedures', mode: 'readonly_procedures' as AccessMode, tools: getToolsForMode('readonly_procedures') },
    { id: 'full', mode: 'full' as AccessMode, tools: getToolsForMode('full') }
  ].filter((mode) => mode.mode !== summary.mode);

  const procedureAllowlistHtml = summary.procedureAllowlist.length > 0
    ? summary.procedureAllowlist.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')
    : '<li><em>No procedures allowlisted</em></li>';

  const otherModesHtml = otherModes.map((mode) => {
    return `<tr>
      <td>${escapeHtml(mode.id)}</td>
      <td>${escapeHtml(mode.mode)}</td>
      <td>Not enabled</td>
      <td>${mode.tools.map((tool) => escapeHtml(tool)).join(', ')}</td>
    </tr>`;
  }).join('');

  const checksHtml = summary.checks.map((check) => {
    const statusEmoji = check.status === 'ok' ? '✅' : check.status === 'error' ? '❌' : '⏭️';
    return `<tr>
      <td>${escapeHtml(check.label)}</td>
      <td><code>${escapeHtml(check.command)}</code></td>
      <td>${statusEmoji} ${escapeHtml(check.status)}</td>
      <td>${check.detail ? escapeHtml(check.detail) : ''}${check.skippedReason ? escapeHtml(check.skippedReason) : ''}${check.error ? 'Error: ' + escapeHtml(check.error.message) : ''}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>DB2 LUW MCP Status</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #f5f5f5; }
    h1 { color: #333; }
    h2 { color: #555; border-bottom: 1px solid #ccc; padding-bottom: 0.25rem; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; }
    th { background: #eee; }
    code { background: #e8e8e8; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.9em; }
    .status-ok { color: green; font-weight: bold; }
    .status-degraded { color: orange; font-weight: bold; }
    .note { background: #fff3cd; border: 1px solid #ffc107; padding: 0.5rem 1rem; margin: 0.5rem 0; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>DB2 LUW MCP Status</h1>
  <p>Checked at: ${escapeHtml(summary.checkedAt)}</p>
  <p>Status: <span class="${summary.status === 'ok' ? 'status-ok' : 'status-degraded'}">${escapeHtml(summary.status.toUpperCase())}</span></p>

  <h2>Active Profile</h2>
  <table>
    <tr><th>Mode</th><td>${escapeHtml(summary.mode)}</td></tr>
    <tr><th>Caller Label</th><td>${escapeHtml(summary.callerLabel)}</td></tr>
    <tr><th>DB Target Label</th><td>${escapeHtml(summary.dbLabel)}</td></tr>
    <tr><th>Tools Enabled (${summary.toolCount})</th><td>${summary.tools.map((tool) => escapeHtml(tool)).join(', ')}</td></tr>
    <tr><th>Public Base URL</th><td>${summary.publicBaseUrl ? escapeHtml(summary.publicBaseUrl) : '<em>Not configured</em>'}</td></tr>
    <tr><th>Working Directory</th><td><code>${escapeHtml(summary.fileLocations.workingDirectory)}</code></td></tr>
  </table>

  <h2>Health Checks</h2>
  <table>
    <tr><th>Check</th><th>Status</th><th>Detail</th></tr>
    <tr>
      <td>Basic Select Probe</td>
      <td>${summary.basicSelect.status === 'ok' ? '✅ ok' : '❌ error'}</td>
      <td>${summary.basicSelect.currentTimestamp ? 'Timestamp: ' + escapeHtml(summary.basicSelect.currentTimestamp) : ''}${summary.basicSelect.error ? 'Error: ' + escapeHtml(summary.basicSelect.error.message) : ''}</td>
    </tr>
    ${checksHtml}
  </table>

  <h2>Procedure Allowlist</h2>
  <ul>${procedureAllowlistHtml}</ul>

  <h2>Other Deployment Modes</h2>
  <p>Set <code>DB2_MCP_MODE</code> to one of these values at deploy time:</p>
  <table>
    <tr><th>Profile</th><th>Mode</th><th>Status</th><th>Tools</th></tr>
    <tr>
      <td>${escapeHtml(summary.mode)}</td>
      <td>${escapeHtml(summary.mode)}</td>
      <td><strong>Active</strong></td>
      <td>${summary.tools.map((tool) => escapeHtml(tool)).join(', ')}</td>
    </tr>
    ${otherModesHtml}
  </table>

  <h2>File Locations</h2>
  <table>
    <tr><th>Runtime Env File</th><td><code>${escapeHtml(summary.fileLocations.runtimeEnvFile)}</code></td></tr>
    <tr><th>Systemd Unit</th><td><code>${escapeHtml(summary.fileLocations.systemdUnit)}</code></td></tr>
    <tr><th>Service Name</th><td><code>${escapeHtml(summary.fileLocations.serviceName)}</code></td></tr>
    <tr><th>Descriptor Files</th><td>${summary.fileLocations.descriptorFiles.length > 0 ? summary.fileLocations.descriptorFiles.map((f) => '<code>' + escapeHtml(f) + '</code>').join('<br>') : '<em>None configured</em>'}</td></tr>
  </table>

  ${summary.notes.length > 0 ? '<h2>Notes</h2>' + summary.notes.map((note) => '<div class="note">' + escapeHtml(note) + '</div>').join('') : ''}
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
