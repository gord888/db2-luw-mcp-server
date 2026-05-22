import type { Db2ClientFactory, QueryResult } from '../db2/Db2Client.js';
import { toAppError } from '../errors/errorMapper.js';
import {
  PROCEDURE_TOOL_NAMES,
  type AccessMode,
  type ResolvedConfig,
  type ResolvedProfileConfig
} from '../config/types.js';

const BASIC_SELECT_HEALTH_SQL = 'SELECT CURRENT TIMESTAMP AS CURRENT_TIMESTAMP FROM SYSIBM.SYSDUMMY1 WITH UR';
const DEFAULT_RUNTIME_ENV_FILE = '/etc/db2-luw-mcp-server.env';
const DEFAULT_SYSTEMD_UNIT = '/etc/systemd/system/db2-luw-mcp-server.service';
const DEFAULT_SERVICE_NAME = 'db2-luw-mcp-server';

export interface ProfileModeSignal {
  label: string;
  status: 'ok' | 'info' | 'warning';
  message: string;
}

export interface ProfileHealthStatus {
  id: string;
  mode: AccessMode;
  callerLabel?: string;
  dbTargetLabel: string;
  enabled: boolean;
  toolCount: number;
  procedureAllowlistCount: number;
  basicSelect: {
    sql: string;
    checkedAt: string;
    status: 'ok' | 'error';
    currentTimestamp?: string;
    error?: {
      code: string;
      message: string;
    };
  };
  modeSignals: ProfileModeSignal[];
}

export interface ServiceHealthSummary {
  checkedAt: string;
  status: 'ok' | 'degraded';
  configPath: string;
  workingDirectory: string;
  publicBaseUrl?: string;
  fileLocations: {
    configPath: string;
    descriptorFiles: string[];
    workingDirectory: string;
    runtimeEnvFile: string;
    systemdUnit: string;
    serviceName: string;
  };
  enabledProfiles: ProfileHealthStatus[];
  notes: string[];
}

function extractCurrentTimestamp(result: QueryResult<Record<string, unknown>>): string | undefined {
  const firstRow = result.rows[0];
  if (!firstRow) {
    return undefined;
  }

  const candidate = firstRow.CURRENT_TIMESTAMP ?? firstRow.current_timestamp ?? Object.values(firstRow)[0];
  return candidate === undefined ? undefined : String(candidate);
}

function buildModeSignals(profile: ResolvedProfileConfig): ProfileModeSignal[] {
  const signals: ProfileModeSignal[] = [
    {
      label: 'Configured tools',
      status: 'info',
      message: `${profile.tools.length} configured tool(s).`
    }
  ];

  if (profile.mode === 'readonly') {
    signals.push({
      label: 'Readonly validation',
      status: 'ok',
      message: 'Basic select health confirms this key can connect and execute a readonly query.'
    });
    return signals;
  }

  if (profile.mode === 'readonly_procedures') {
    signals.push({
      label: 'Procedure tool availability',
      status: profile.tools.includes(PROCEDURE_TOOL_NAMES[2]) ? 'ok' : 'warning',
      message: profile.tools.includes(PROCEDURE_TOOL_NAMES[2])
        ? 'Procedure execution tool is enabled for this profile.'
        : 'Procedure execution tool is not enabled for this profile.'
    });
    signals.push({
      label: 'Procedure allowlist',
      status: profile.procedureAllowlist.length > 0 ? 'ok' : 'warning',
      message: profile.procedureAllowlist.length > 0
        ? `${profile.procedureAllowlist.length} allowlisted procedure(s) configured: ${profile.procedureAllowlist.map((entry) => `${entry.schema}.${entry.name}`).join(', ')}.`
        : 'No allowlisted procedures are configured.'
    });
    return signals;
  }

  signals.push({
    label: 'Full mode readiness',
    status: profile.tools.length > 0 ? 'info' : 'warning',
    message: profile.tools.length > 0
      ? `Full mode is enabled with ${profile.tools.length} configured tool(s).`
      : 'Full mode is enabled, but no full-mode tools are configured in this build.'
  });

  return signals;
}

async function collectProfileHealth(
  profile: ResolvedProfileConfig,
  db2ClientFactory: Db2ClientFactory,
  queryTimeoutMs: number
): Promise<ProfileHealthStatus> {
  const client = db2ClientFactory.create(profile);
  const checkedAt = new Date().toISOString();

  try {
    const result = await client.query<Record<string, unknown>>(BASIC_SELECT_HEALTH_SQL, [], {
      timeoutMs: queryTimeoutMs,
      label: `${profile.id} health check`
    });

    return {
      id: profile.id,
      mode: profile.mode,
      callerLabel: profile.callerLabel,
      dbTargetLabel: profile.db.targetLabel,
      enabled: profile.enabled,
      toolCount: profile.tools.length,
      procedureAllowlistCount: profile.procedureAllowlist.length,
      basicSelect: {
        sql: BASIC_SELECT_HEALTH_SQL,
        checkedAt,
        status: 'ok',
        currentTimestamp: extractCurrentTimestamp(result)
      },
      modeSignals: buildModeSignals(profile)
    };
  } catch (error) {
    const appError = toAppError(error);

    return {
      id: profile.id,
      mode: profile.mode,
      callerLabel: profile.callerLabel,
      dbTargetLabel: profile.db.targetLabel,
      enabled: profile.enabled,
      toolCount: profile.tools.length,
      procedureAllowlistCount: profile.procedureAllowlist.length,
      basicSelect: {
        sql: BASIC_SELECT_HEALTH_SQL,
        checkedAt,
        status: 'error',
        error: {
          code: appError.code,
          message: appError.message
        }
      },
      modeSignals: buildModeSignals(profile)
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function collectServiceHealthSummary(
  config: ResolvedConfig,
  db2ClientFactory: Db2ClientFactory
): Promise<ServiceHealthSummary> {
  const enabledProfiles = Object.values(config.profiles).filter((profile) => profile.enabled);
  const profileSummaries = await Promise.all(
    enabledProfiles.map(async (profile) => collectProfileHealth(profile, db2ClientFactory, config.limits.queryTimeoutMs))
  );

  const hasFailures = profileSummaries.some((profile) => profile.basicSelect.status === 'error');
  const notes: string[] = [
    'Recommended deployment validation: call /healthz and run an MCP query such as select * from tmwin.tlorder limit 1.'
  ];

  if (enabledProfiles.length === 0) {
    notes.push('No enabled profiles are currently configured.');
  }

  return {
    checkedAt: new Date().toISOString(),
    status: enabledProfiles.length > 0 && !hasFailures ? 'ok' : 'degraded',
    configPath: config.configPath,
    workingDirectory: process.cwd(),
    publicBaseUrl: config.server.publicBaseUrl,
    fileLocations: {
      configPath: config.configPath,
      descriptorFiles: config.descriptorFiles,
      workingDirectory: process.cwd(),
      runtimeEnvFile: DEFAULT_RUNTIME_ENV_FILE,
      systemdUnit: DEFAULT_SYSTEMD_UNIT,
      serviceName: DEFAULT_SERVICE_NAME
    },
    enabledProfiles: profileSummaries,
    notes
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderModeSignals(signals: ProfileModeSignal[]): string {
  if (signals.length === 0) {
    return '<em>None</em>';
  }

  return `<ul>${signals.map((signal) => `<li><strong>${escapeHtml(signal.label)}:</strong> ${escapeHtml(signal.message)}</li>`).join('')}</ul>`;
}

function renderDescriptorFiles(descriptorFiles: string[]): string {
  if (descriptorFiles.length === 0) {
    return '<li><strong>Descriptor files:</strong> None configured</li>';
  }

  return descriptorFiles
    .map((descriptorFile) => `<li><strong>Descriptor file:</strong> <code>${escapeHtml(descriptorFile)}</code></li>`)
    .join('');
}

export function renderStatusPage(summary: ServiceHealthSummary): string {
  const statusColor = summary.status === 'ok' ? '#0f766e' : '#b91c1c';
  const profileRows = summary.enabledProfiles.length > 0
    ? summary.enabledProfiles.map((profile) => `
        <tr>
          <td>${escapeHtml(profile.id)}</td>
          <td>${escapeHtml(profile.mode)}</td>
          <td>${escapeHtml(profile.dbTargetLabel)}</td>
          <td>${profile.basicSelect.status === 'ok'
            ? `<span style="color:${statusColor};font-weight:bold;">ok</span><br><small>${escapeHtml(profile.basicSelect.currentTimestamp ?? 'timestamp unavailable')}</small>`
            : `<span style="color:${statusColor};font-weight:bold;">error</span><br><small>${escapeHtml(profile.basicSelect.error?.message ?? 'Unknown error')}</small>`}</td>
          <td>${renderModeSignals(profile.modeSignals)}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="5">No enabled profiles are configured.</td></tr>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>DB2 LUW MCP Status</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 2rem; line-height: 1.4; }
      table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
      th, td { border: 1px solid #d1d5db; padding: 0.75rem; vertical-align: top; text-align: left; }
      th { background: #f3f4f6; }
      code { background: #f3f4f6; padding: 0.1rem 0.25rem; }
      .status { color: ${statusColor}; font-weight: bold; }
    </style>
  </head>
  <body>
    <h1>DB2 LUW MCP Status</h1>
    <p><span class="status">${escapeHtml(summary.status)}</span> &middot; Checked at ${escapeHtml(summary.checkedAt)}</p>

    <h2>Enabled Profiles</h2>
    <table>
      <thead>
        <tr>
          <th>Profile</th>
          <th>Mode</th>
          <th>DB target</th>
          <th>Basic select check</th>
          <th>Mode signals</th>
        </tr>
      </thead>
      <tbody>
        ${profileRows}
      </tbody>
    </table>

    <h2>File Locations</h2>
    <ul>
      <li><strong>Active config:</strong> <code>${escapeHtml(summary.fileLocations.configPath)}</code></li>
      <li><strong>Working directory:</strong> <code>${escapeHtml(summary.fileLocations.workingDirectory)}</code></li>
      <li><strong>Default runtime env file:</strong> <code>${escapeHtml(summary.fileLocations.runtimeEnvFile)}</code></li>
      <li><strong>Default systemd unit:</strong> <code>${escapeHtml(summary.fileLocations.systemdUnit)}</code></li>
      <li><strong>Service name:</strong> <code>${escapeHtml(summary.fileLocations.serviceName)}</code></li>
      ${renderDescriptorFiles(summary.fileLocations.descriptorFiles)}
    </ul>

    <h2>Basic Instructions</h2>
    <ol>
      <li>Edit the runtime env file and replace placeholder API keys and DB2 connection strings.</li>
      <li>If you need a different mode, switch <code>DB2_MCP_CONFIG_PATH</code> to the desired YAML file or update the active config.</li>
      <li>Restart the service with <code>systemctl restart ${escapeHtml(summary.fileLocations.serviceName)}</code>.</li>
      <li>Validate <code>/healthz</code> and then run an MCP query such as <code>select * from tmwin.tlorder limit 1</code>.</li>
    </ol>

    <h2>Notes</h2>
    <ul>
      ${summary.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}
      ${summary.publicBaseUrl ? `<li><strong>Configured public base URL:</strong> <code>${escapeHtml(summary.publicBaseUrl)}</code></li>` : ''}
    </ul>
  </body>
</html>`;
}
