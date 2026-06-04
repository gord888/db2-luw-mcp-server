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
  configErrors: Array<{ variable: string; message: string }>;
  hasConnection: boolean;
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
  const checks: ProfileHealthCheck[] = [];
  const notes: string[] = [];
  const hasConnection = config.connectionString.length > 0;

  let basicSelectStatus: 'ok' | 'error' | 'skipped' = 'skipped';
  let currentTimestamp: string | undefined;
  let basicSelectError: { code: string; message: string } | undefined;
  let basicSelectSkippedReason: string | undefined;

  if (!hasConnection) {
    basicSelectSkippedReason = 'No DB2 connection string configured. Set DB2_MCP_CONNECTION_STRING or individual DB2_MCP_CONNECTION_STRING_* environment variables.';
    notes.push('Database health probes skipped: no connection string configured.');
  } else {
    const client = db2ClientFactory.create(config);

    try {
      const result = await client.query(BASIC_SELECT_HEALTH_SQL, [], {
        timeoutMs: config.limits.metadataTimeoutMs,
        label: 'health_basic_select'
      });
      currentTimestamp = extractCurrentTimestamp(result.rows);
      basicSelectStatus = 'ok';
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

    await client.close().catch(() => undefined);
  }

  const hasConfigErrors = config.configErrors.length > 0;
  const overallStatus = !hasConfigErrors && basicSelectStatus === 'ok'
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
    configErrors: config.configErrors,
    hasConnection,
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
      skippedReason: basicSelectSkippedReason,
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
      <td><span class="badge badge-skipped">Not enabled</span></td>
      <td>${mode.tools.map((tool) => '<code>' + escapeHtml(tool) + '</code>').join(', ')}</td>
    </tr>`;
  }).join('');

  const checksHtml = summary.checks.map((check) => {
    const statusEmoji = check.status === 'ok' ? '✅' : check.status === 'error' ? '❌' : '⏭️';
    const detailParts: string[] = [];
    if (check.command) {
      detailParts.push(`<code>${escapeHtml(check.command)}</code>`);
    }
    if (check.detail) {
      detailParts.push(escapeHtml(check.detail));
    }
    if (check.skippedReason) {
      detailParts.push(escapeHtml(check.skippedReason));
    }
    if (check.error) {
      detailParts.push('Error: ' + escapeHtml(check.error.message));
    }
    return `<tr>
      <td>${escapeHtml(check.label)}</td>
      <td class="detail-cell">${detailParts.join('<br>')}</td>
      <td>${statusEmoji} ${escapeHtml(check.status)}</td>
    </tr>`;
  }).join('');

  const basicSelectHtml = summary.basicSelect.status === 'skipped'
    ? '<span class="status-skipped">⏭️ Skipped</span>' + (summary.basicSelect.skippedReason ? '<div class="detail-text">' + escapeHtml(summary.basicSelect.skippedReason) + '</div>' : '')
    : summary.basicSelect.status === 'ok'
      ? '<span class="status-ok">✅ OK</span>' + (summary.basicSelect.currentTimestamp ? '<div class="detail-text">' + escapeHtml(summary.basicSelect.currentTimestamp) + '</div>' : '')
      : '<span class="status-error">❌ Error</span>' + (summary.basicSelect.error ? '<div class="detail-text">' + escapeHtml(summary.basicSelect.error.message) + '</div>' : '');

  const configErrorsHtml = summary.configErrors.length > 0
    ? `<div class="card" style="border-color:#dc2626; background:#fef2f2;">
       <h2 style="color:#991b1b;">⚠️ Configuration Errors</h2>
       <p style="margin-bottom:0.75rem;color:#991b1b;font-size:0.88rem;">The following environment variables are missing or invalid. The server is running in degraded mode until these are resolved:</p>
       <table>
         <thead><tr><th style="width:280px;">Variable</th><th>Error</th></tr></thead>
         <tbody>
           ${summary.configErrors.map((err) => `<tr><td><code>${escapeHtml(err.variable)}</code></td><td style="color:#991b1b;">${escapeHtml(err.message)}</td></tr>`).join('')}
         </tbody>
       </table>
       <p style="margin-top:0.75rem;font-size:0.82rem;color:#991b1b;">Set these variables in <code>${escapeHtml(summary.fileLocations.runtimeEnvFile)}</code> and restart the service: <code>systemctl restart ${escapeHtml(summary.fileLocations.serviceName)}</code></p>
     </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>DB2 LUW MCP Status</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f0f2f5; color: #1a1a2e; line-height: 1.6; }
    .container { max-width: 1100px; margin: 0 auto; padding: 1.5rem; }
    header { background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%); color: #fff; border-radius: 10px; padding: 1.5rem 2rem; margin-bottom: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.12); }
    header h1 { font-size: 1.5rem; font-weight: 700; }
    header .subtitle { font-size: 0.85rem; opacity: 0.85; margin-top: 0.25rem; }
    header .status-pill { display: inline-block; padding: 0.2rem 0.75rem; border-radius: 20px; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; margin-top: 0.5rem; }
    .status-pill-ok { background: #16a34a; }
    .status-pill-degraded { background: #ea580c; }
    nav { margin-top: 0.75rem; }
    nav a { color: rgba(255,255,255,0.85); text-decoration: none; font-size: 0.85rem; font-weight: 500; margin-right: 1.25rem; }
    nav a:hover { color: #fff; text-decoration: underline; }
    .card { background: #fff; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.06); border: 1px solid #e5e7eb; }
    .card h2 { font-size: 1.1rem; color: #1e3a5f; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 2px solid #e5e7eb; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    thead th { text-align: left; background: #f8fafc; color: #475569; font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.6rem 0.75rem; border-bottom: 2px solid #e2e8f0; }
    tbody td { padding: 0.55rem 0.75rem; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: #f8fafc; }
    code { background: #eef2ff; color: #4338ca; padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.85em; font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; }
    pre { background: #1e293b; color: #e2e8f0; padding: 1rem 1.25rem; border-radius: 6px; overflow-x: auto; font-size: 0.8rem; line-height: 1.5; margin: 0.5rem 0; }
    pre code { background: none; color: inherit; padding: 0; font-size: inherit; }
    .status-ok { color: #16a34a; font-weight: 600; }
    .status-error { color: #dc2626; font-weight: 600; }
    .status-skipped { color: #64748b; font-weight: 600; }
    .note { background: #fffbeb; border: 1px solid #fcd34d; padding: 0.6rem 1rem; margin: 0.5rem 0; border-radius: 6px; font-size: 0.88rem; line-height: 1.5; }
    .kv-table th { width: 180px; white-space: nowrap; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
    @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } .container { padding: 0.75rem; } }
    .detail-cell { font-size: 0.82rem; }
    .detail-cell code { display: block; margin-bottom: 0.25rem; }
    .detail-text { color: #64748b; font-size: 0.82rem; }
    .badge { display: inline-block; padding: 0.12rem 0.45rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .badge-ok { background: #dcfce7; color: #166534; }
    .badge-error { background: #fef2f2; color: #991b1b; }
    .badge-skipped { background: #f1f5f9; color: #64748b; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>DB2 LUW MCP Server</h1>
      <div class="subtitle">Checked at ${escapeHtml(summary.checkedAt)}</div>
      <div class="status-pill ${summary.status === 'ok' ? 'status-pill-ok' : 'status-pill-degraded'}">${escapeHtml(summary.status.toUpperCase())}</div>
      <nav>
        <a href="/status">Status</a>
        <a href="/descriptors">Descriptors</a>
        <a href="/healthz">Health JSON</a>
      </nav>
    </header>

    ${configErrorsHtml}

    <div class="grid-2">
      <div class="card">
        <h2>Active Profile</h2>
        <table class="kv-table">
          <tbody>
            <tr><th>Mode</th><td>${escapeHtml(summary.mode)}</td></tr>
            <tr><th>Caller Label</th><td>${escapeHtml(summary.callerLabel)}</td></tr>
            <tr><th>DB Target Label</th><td>${escapeHtml(summary.dbLabel)}</td></tr>
            <tr><th>Tools Enabled</th><td><span class="badge badge-ok">${summary.toolCount}</span> ${summary.tools.map((tool) => '<code>' + escapeHtml(tool) + '</code>').join(', ')}</td></tr>
            <tr><th>Public Base URL</th><td>${summary.publicBaseUrl ? '<code>' + escapeHtml(summary.publicBaseUrl) + '</code>' : '<em>Not configured</em>'}</td></tr>
            <tr><th>Working Directory</th><td><code>${escapeHtml(summary.fileLocations.workingDirectory)}</code></td></tr>
          </tbody>
        </table>
      </div>
      <div class="card">
        <h2>File Locations</h2>
        <table class="kv-table">
          <tbody>
            <tr><th>Runtime Env File</th><td><code>${escapeHtml(summary.fileLocations.runtimeEnvFile)}</code></td></tr>
            <tr><th>Systemd Unit</th><td><code>${escapeHtml(summary.fileLocations.systemdUnit)}</code></td></tr>
            <tr><th>Service Name</th><td><code>${escapeHtml(summary.fileLocations.serviceName)}</code></td></tr>
            <tr><th>Descriptor Files</th><td>${summary.fileLocations.descriptorFiles.length > 0 ? summary.fileLocations.descriptorFiles.map((f) => '<code>' + escapeHtml(f) + '</code>').join('<br>') : '<em>None configured</em>'}</td></tr>
          </tbody>
        </table>
      </div>
    </div>

  <div class="card">
    <h2>Health Checks</h2>
    <table>
      <thead>
        <tr><th>Check</th><th>Detail</th><th style="width:130px;">Status</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>Basic Select Probe</td>
          <td class="detail-cell"><code>${escapeHtml(summary.basicSelect.sql)}</code></td>
          <td>${basicSelectHtml}</td>
        </tr>
        ${checksHtml}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Service Endpoints</h2>
    <table>
      <thead>
        <tr><th>Endpoint</th><th style="width:160px;">Method</th><th>URL</th></tr>
      </thead>
      <tbody>
        <tr><td>MCP Protocol</td><td>GET, POST, DELETE</td><td>${summary.publicBaseUrl ? '<code>' + escapeHtml(summary.publicBaseUrl) + '/mcp</code>' : '<code>/mcp</code>'}</td></tr>
        <tr><td>Status Page</td><td>GET</td><td>${summary.publicBaseUrl ? '<code>' + escapeHtml(summary.publicBaseUrl) + '/status</code>' : '<code>/status</code>'}</td></tr>
        <tr><td>Descriptor Manager</td><td>GET</td><td>${summary.publicBaseUrl ? '<code>' + escapeHtml(summary.publicBaseUrl) + '/descriptors</code>' : '<code>/descriptors</code>'}</td></tr>
        <tr><td>Health Check</td><td>GET</td><td>${summary.publicBaseUrl ? '<code>' + escapeHtml(summary.publicBaseUrl) + '/healthz</code>' : '<code>/healthz</code>'}</td></tr>
        <tr><td>Readiness Check</td><td>GET</td><td>${summary.publicBaseUrl ? '<code>' + escapeHtml(summary.publicBaseUrl) + '/readyz</code>' : '<code>/readyz</code>'}</td></tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Example MCP Client Config</h2>
    <p style="margin-bottom:0.5rem;color:#64748b;font-size:0.88rem;">Use this in your <code>.mcp.json</code> or client config to connect:</p>
    <pre><code>${escapeHtml(JSON.stringify({
      mcpServers: {
        'db2-luw': {
          type: 'stdio',
          command: 'npx',
          args: [
            '-y', 'mcp-remote',
            (summary.publicBaseUrl ?? 'http://&lt;host&gt;:3000') + '/mcp',
            '--allow-http',
            '--header', 'Authorization:${DB2_LUW_AUTH}'
          ],
          env: { DB2_LUW_AUTH: 'Bearer &lt;api-key&gt;' },
          tools: ['*']
        }
      }
    }, null, 2))}</code></pre>
  </div>

  <div class="card">
    <h2>Procedure Allowlist</h2>
    <ul>${procedureAllowlistHtml}</ul>
  </div>

  <div class="card">
    <h2>Other Deployment Modes</h2>
    <p style="margin-bottom:0.75rem;color:#64748b;font-size:0.88rem;">Set <code>DB2_MCP_MODE</code> to one of these values at deploy time:</p>
    <table>
      <thead><tr><th>Profile</th><th>Mode</th><th>Status</th><th>Tools</th></tr></thead>
      <tbody>
        <tr>
          <td>${escapeHtml(summary.mode)}</td>
          <td>${escapeHtml(summary.mode)}</td>
          <td><span class="badge badge-ok">Active</span></td>
          <td>${summary.tools.map((tool) => '<code>' + escapeHtml(tool) + '</code>').join(', ')}</td>
        </tr>
        ${otherModesHtml}
      </tbody>
    </table>
  </div>

  ${summary.notes.length > 0 ? '<div class="card"><h2>Notes</h2>' + summary.notes.map((note) => '<div class="note">' + escapeHtml(note) + '</div>').join('') + '</div>' : ''}
</div>
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
