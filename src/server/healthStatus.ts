import type { Db2Client, Db2ClientFactory, Db2Parameter, QueryResult } from '../db2/Db2Client.js';
import { toAppError } from '../errors/errorMapper.js';
import {
  FULL_DDL_TOOL_NAMES,
  PROCEDURE_TOOL_NAMES,
  READONLY_TOOL_NAMES,
  type AccessMode,
  type ResolvedConfig,
  type ResolvedProfileConfig,
  type ToolName
} from '../config/types.js';

const BASIC_SELECT_HEALTH_SQL = 'SELECT CURRENT TIMESTAMP AS CURRENT_TIMESTAMP FROM SYSIBM.SYSDUMMY1 WITH UR';
const PROCEDURE_ACCESS_PROBE_COMMAND = 'CALL SYSPROC.GET_DBSIZE_INFO(?, ?, ?, -1)';
const FULL_CREATE_PROCEDURE_COMMAND = 'CREATE OR REPLACE PROCEDURE DB2MCP_STATUS_CHECK() LANGUAGE SQL BEGIN DECLARE HEALTHCHECK_VALUE INTEGER DEFAULT 4242; END';
const DEFAULT_RUNTIME_ENV_FILE = '/etc/db2-luw-mcp-server.env';
const DEFAULT_SYSTEMD_UNIT = '/etc/systemd/system/db2-luw-mcp-server.service';
const DEFAULT_SERVICE_NAME = 'db2-luw-mcp-server';
const STANDARD_PROFILE_ORDER = ['readonly', 'readonly_procedures', 'full'] as const;
const DEFAULT_READONLY_PROCEDURES_ALLOWLIST = ['SYSPROC.GET_DBSIZE_INFO'];
const SHARED_RW_TOOLS: ToolName[] = [...READONLY_TOOL_NAMES, ...PROCEDURE_TOOL_NAMES];
const FULL_MODE_TOOLS: ToolName[] = [...SHARED_RW_TOOLS, ...FULL_DDL_TOOL_NAMES];
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

type BasicSelectStatus = 'ok' | 'error' | 'skipped';
type CheckStatus = 'ok' | 'error' | 'skipped';
type ProfileConfigurationStatus = 'enabled' | 'disabled' | 'not_configured';

interface StandardProfileDefinition {
  id: string;
  mode: AccessMode;
  callerLabel: string;
  dbTargetLabel: string;
  tools: ToolName[];
  procedureAllowlist: string[];
}

const STANDARD_PROFILE_DEFINITIONS: StandardProfileDefinition[] = [
  {
    id: 'readonly',
    mode: 'readonly',
    callerLabel: 'readonly',
    dbTargetLabel: 'db2-luw-readonly',
    tools: [...READONLY_TOOL_NAMES],
    procedureAllowlist: []
  },
  {
    id: 'readonly_procedures',
    mode: 'readonly_procedures',
    callerLabel: 'readonly_procedures',
    dbTargetLabel: 'db2-luw-readonly-procedures',
    tools: [...SHARED_RW_TOOLS],
    procedureAllowlist: [...DEFAULT_READONLY_PROCEDURES_ALLOWLIST]
  },
  {
    id: 'full',
    mode: 'full',
    callerLabel: 'full',
    dbTargetLabel: 'db2-luw-full',
    tools: [...FULL_MODE_TOOLS],
    procedureAllowlist: []
  }
];

export interface ProfileModeSignal {
  label: string;
  status: 'ok' | 'info' | 'warning';
  message: string;
}

export interface ProfileHealthCheck {
  label: string;
  command: string;
  checkedAt: string;
  status: CheckStatus;
  detail?: string;
  skippedReason?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface ProfileHealthStatus {
  id: string;
  mode: AccessMode;
  callerLabel?: string;
  dbTargetLabel: string;
  enabled: boolean;
  configured: boolean;
  configurationStatus: ProfileConfigurationStatus;
  tools: ToolName[];
  toolCount: number;
  procedureAllowlist: string[];
  procedureAllowlistCount: number;
  basicSelect: {
    sql: string;
    checkedAt: string;
    status: BasicSelectStatus;
    currentTimestamp?: string;
    skippedReason?: string;
    error?: {
      code: string;
      message: string;
    };
  };
  checks: ProfileHealthCheck[];
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
  profiles: ProfileHealthStatus[];
  enabledProfiles: ProfileHealthStatus[];
  notes: string[];
}

export interface HealthSummaryOptions {
  includeDetailedChecks?: boolean;
}

function extractCurrentTimestamp(result: QueryResult<Record<string, unknown>>): string | undefined {
  const firstRow = result.rows[0];
  if (!firstRow) {
    return undefined;
  }

  const candidate = firstRow.CURRENT_TIMESTAMP ?? firstRow.current_timestamp ?? Object.values(firstRow)[0];
  return candidate === undefined ? undefined : String(candidate);
}

function formatProcedureAllowlist(profile: Pick<ResolvedProfileConfig, 'procedureAllowlist'>): string[] {
  return profile.procedureAllowlist.map((entry) => `${entry.schema}.${entry.name}`);
}

function buildStaticModeSignals(profile: {
  mode: AccessMode;
  enabled: boolean;
  configured: boolean;
  tools: ToolName[];
  procedureAllowlist: string[];
}): ProfileModeSignal[] {
  const signals: ProfileModeSignal[] = [
    {
      label: 'Profile state',
      status: profile.enabled ? 'ok' : 'warning',
      message: profile.enabled
        ? 'Enabled in the active config.'
        : profile.configured
          ? 'Present in the active config, but disabled.'
          : 'Not defined in the active config and treated as disabled.'
    },
    {
      label: 'Configured tools',
      status: profile.tools.length > 0 ? 'info' : 'warning',
      message: profile.tools.length > 0
        ? `${profile.tools.length} configured tool(s).`
        : 'No tools are configured for this profile.'
    }
  ];

  if (profile.mode === 'readonly') {
    signals.push({
      label: 'Readonly validation',
      status: profile.enabled ? 'ok' : 'info',
      message: profile.enabled
        ? 'The select probe is the readonly validation for this profile.'
        : 'Enable this profile to run the readonly select probe.'
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
        ? `${profile.procedureAllowlist.length} allowlisted procedure(s) configured: ${profile.procedureAllowlist.join(', ')}.`
        : 'No allowlisted procedures are configured.'
    });
    return signals;
  }

  signals.push({
    label: 'Full mode tool coverage',
    status: profile.tools.length > 0 ? 'ok' : 'warning',
    message: profile.tools.length > 0
      ? `Full mode currently exposes ${profile.tools.length} implemented tool(s), including deploy/drop management for procedures, functions, and views, while the status page runs an additional create-or-replace permission probe.`
      : 'No tools are configured for this full profile.'
  });

  return signals;
}

function buildCheckError(error: unknown): { code: string; message: string } {
  const appError = toAppError(error);

  return {
    code: appError.code,
    message: appError.message
  };
}

async function runBasicSelectCheck(profile: ResolvedProfileConfig, client: Db2Client, queryTimeoutMs: number): Promise<{
  basicSelect: ProfileHealthStatus['basicSelect'];
  check: ProfileHealthCheck;
}> {
  const checkedAt = new Date().toISOString();

  try {
    const result = await client.query<Record<string, unknown>>(BASIC_SELECT_HEALTH_SQL, [], {
      timeoutMs: queryTimeoutMs,
      label: `${profile.id} health check`
    });
    const currentTimestamp = extractCurrentTimestamp(result);

    return {
      basicSelect: {
        sql: BASIC_SELECT_HEALTH_SQL,
        checkedAt,
        status: 'ok',
        currentTimestamp
      },
      check: {
        label: 'Select probe',
        command: BASIC_SELECT_HEALTH_SQL,
        checkedAt,
        status: 'ok',
        detail: currentTimestamp ?? 'Query succeeded.'
      }
    };
  } catch (error) {
    const mappedError = buildCheckError(error);

    return {
      basicSelect: {
        sql: BASIC_SELECT_HEALTH_SQL,
        checkedAt,
        status: 'error',
        error: mappedError
      },
      check: {
        label: 'Select probe',
        command: BASIC_SELECT_HEALTH_SQL,
        checkedAt,
        status: 'error',
        error: mappedError
      }
    };
  }
}

async function runProcedureAccessCheck(client: Db2Client, queryTimeoutMs: number): Promise<ProfileHealthCheck> {
  const checkedAt = new Date().toISOString();

  try {
    const result = await client.callProcedure(
      PROCEDURE_ACCESS_PROBE.schema,
      PROCEDURE_ACCESS_PROBE.name,
      PROCEDURE_ACCESS_PROBE.params,
      {
        timeoutMs: queryTimeoutMs,
        label: 'stored procedure access check'
      }
    );

    return {
      label: 'Stored procedure probe',
      command: PROCEDURE_ACCESS_PROBE_COMMAND,
      checkedAt,
      status: 'ok',
      detail: `Stored procedure call succeeded. Snapshot timestamp: ${String(result.outputParameters.param1 ?? 'unknown')}, database size: ${String(result.outputParameters.param2 ?? 'unknown')}, database capacity: ${String(result.outputParameters.param3 ?? 'unknown')}.`
    };
  } catch (error) {
    return {
      label: 'Stored procedure probe',
      command: PROCEDURE_ACCESS_PROBE_COMMAND,
      checkedAt,
      status: 'error',
      error: buildCheckError(error)
    };
  }
}

async function runCreateReplaceProcedureCheck(client: Db2Client, queryTimeoutMs: number): Promise<ProfileHealthCheck> {
  const checkedAt = new Date().toISOString();

  try {
    await client.query(FULL_CREATE_PROCEDURE_COMMAND, [], {
      timeoutMs: queryTimeoutMs,
      label: 'create or replace db2mcp_status_check'
    });

    return {
      label: 'Create or replace procedure probe',
      command: FULL_CREATE_PROCEDURE_COMMAND,
      checkedAt,
      status: 'ok',
      detail: 'Create or replace procedure succeeded.'
    };
  } catch (error) {
    return {
      label: 'Create or replace procedure probe',
      command: FULL_CREATE_PROCEDURE_COMMAND,
      checkedAt,
      status: 'error',
      error: buildCheckError(error)
    };
  }
}

function buildSkippedCheck(label: string, command: string, reason: string): ProfileHealthCheck {
  return {
    label,
    command,
    checkedAt: new Date().toISOString(),
    status: 'skipped',
    skippedReason: reason
  };
}

async function collectDetailedChecks(
  profile: ResolvedProfileConfig,
  client: Db2Client,
  queryTimeoutMs: number
): Promise<ProfileHealthCheck[]> {
  const checks: ProfileHealthCheck[] = [];

  if (profile.mode === 'readonly') {
    return checks;
  }

  checks.push(await runProcedureAccessCheck(client, queryTimeoutMs));

  if (profile.mode === 'full') {
    checks.push(await runCreateReplaceProcedureCheck(client, queryTimeoutMs));
  }

  return checks;
}

async function collectProfileHealth(
  profile: ResolvedProfileConfig,
  db2ClientFactory: Db2ClientFactory,
  queryTimeoutMs: number,
  options: HealthSummaryOptions
): Promise<ProfileHealthStatus> {
  const client = db2ClientFactory.create(profile);
  const procedureAllowlist = formatProcedureAllowlist(profile);
  const modeSignals = buildStaticModeSignals({
    mode: profile.mode,
    enabled: true,
    configured: true,
    tools: profile.tools,
    procedureAllowlist
  });

  try {
    const basicSelectResult = await runBasicSelectCheck(profile, client, queryTimeoutMs);
    const checks = [basicSelectResult.check];

    if (options.includeDetailedChecks && basicSelectResult.basicSelect.status === 'ok') {
      checks.push(...await collectDetailedChecks(profile, client, queryTimeoutMs));
    }

    return {
      id: profile.id,
      mode: profile.mode,
      callerLabel: profile.callerLabel,
      dbTargetLabel: profile.db.targetLabel,
      enabled: true,
      configured: true,
      configurationStatus: 'enabled',
      tools: profile.tools,
      toolCount: profile.tools.length,
      procedureAllowlist,
      procedureAllowlistCount: profile.procedureAllowlist.length,
      basicSelect: basicSelectResult.basicSelect,
      checks,
      modeSignals
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function buildInactiveChecks(
  profile: {
    mode: AccessMode;
  },
  configurationStatus: Exclude<ProfileConfigurationStatus, 'enabled'>
): ProfileHealthCheck[] {
  const reason = configurationStatus === 'disabled'
    ? 'Profile is disabled, so this check was not run.'
    : 'Profile is not defined in the active config and is treated as disabled.';
  const checks = [buildSkippedCheck('Select probe', BASIC_SELECT_HEALTH_SQL, reason)];

  if (profile.mode === 'readonly_procedures' || profile.mode === 'full') {
    checks.push(buildSkippedCheck('Stored procedure probe', PROCEDURE_ACCESS_PROBE_COMMAND, reason));
  }

  if (profile.mode === 'full') {
    checks.push(buildSkippedCheck('Create or replace procedure probe', FULL_CREATE_PROCEDURE_COMMAND, reason));
  }

  return checks;
}

function buildInactiveProfileHealth(
  profile: {
    id: string;
    mode: AccessMode;
    callerLabel?: string;
    dbTargetLabel: string;
    tools: ToolName[];
    procedureAllowlist: string[];
  },
  configurationStatus: Exclude<ProfileConfigurationStatus, 'enabled'>
): ProfileHealthStatus {
  const configured = configurationStatus === 'disabled';

  return {
    id: profile.id,
    mode: profile.mode,
    callerLabel: profile.callerLabel,
    dbTargetLabel: profile.dbTargetLabel,
    enabled: false,
    configured,
    configurationStatus,
    tools: profile.tools,
    toolCount: profile.tools.length,
    procedureAllowlist: profile.procedureAllowlist,
    procedureAllowlistCount: profile.procedureAllowlist.length,
    basicSelect: {
      sql: BASIC_SELECT_HEALTH_SQL,
      checkedAt: new Date().toISOString(),
      status: 'skipped',
      skippedReason: configured
        ? 'Profile is disabled, so no database check was run.'
        : 'Profile is not defined in the active config and is treated as disabled.'
    },
    checks: buildInactiveChecks(profile, configurationStatus),
    modeSignals: buildStaticModeSignals({
      mode: profile.mode,
      enabled: false,
      configured,
      tools: profile.tools,
      procedureAllowlist: profile.procedureAllowlist
    })
  };
}

function sortProfiles(profiles: ProfileHealthStatus[]): ProfileHealthStatus[] {
  return [...profiles].sort((left, right) => {
    const leftIndex = STANDARD_PROFILE_ORDER.indexOf(left.id as typeof STANDARD_PROFILE_ORDER[number]);
    const rightIndex = STANDARD_PROFILE_ORDER.indexOf(right.id as typeof STANDARD_PROFILE_ORDER[number]);

    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
        - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
    }

    return left.id.localeCompare(right.id);
  });
}

export async function collectServiceHealthSummary(
  config: ResolvedConfig,
  db2ClientFactory: Db2ClientFactory,
  options: HealthSummaryOptions = {}
): Promise<ServiceHealthSummary> {
  const configuredProfiles = Object.values(config.profiles);
  const configuredProfileSummaries = await Promise.all(
    configuredProfiles.map(async (profile) => (
      profile.enabled
        ? collectProfileHealth(profile, db2ClientFactory, config.limits.queryTimeoutMs, options)
        : Promise.resolve(buildInactiveProfileHealth({
          id: profile.id,
          mode: profile.mode,
          callerLabel: profile.callerLabel,
          dbTargetLabel: profile.db.targetLabel,
          tools: profile.tools,
          procedureAllowlist: formatProcedureAllowlist(profile)
        }, 'disabled'))
    ))
  );

  const configuredProfileIds = new Set(configuredProfiles.map((profile) => profile.id));
  const implicitProfiles = STANDARD_PROFILE_DEFINITIONS
    .filter((profile) => !configuredProfileIds.has(profile.id))
    .map((profile) => buildInactiveProfileHealth({
      id: profile.id,
      mode: profile.mode,
      callerLabel: profile.callerLabel,
      dbTargetLabel: profile.dbTargetLabel,
      tools: profile.tools,
      procedureAllowlist: profile.procedureAllowlist
    }, 'not_configured'));

  const profiles = sortProfiles([...configuredProfileSummaries, ...implicitProfiles]);
  const enabledProfiles = profiles.filter((profile) => profile.enabled);
  const hasFailures = enabledProfiles.some((profile) => profile.checks.some((check) => check.status === 'error'));
  const notes: string[] = [
    'Recommended deployment validation: call /healthz and run an MCP query such as select * from tmwin.tlorder limit 1.'
  ];

  if (enabledProfiles.length === 0) {
    notes.push('No enabled profiles are currently configured.');
  }

  if (options.includeDetailedChecks) {
    notes.push('The status page runs deeper per-mode checks than /healthz and /readyz, including stored procedure and create-or-replace probes where applicable.');
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
    profiles,
    enabledProfiles,
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

function renderToolList(tools: ToolName[]): string {
  if (tools.length === 0) {
    return '<em>None</em>';
  }

  return `<ul>${tools.map((tool) => `<li><code>${escapeHtml(tool)}</code></li>`).join('')}</ul>`;
}

function renderDescriptorFiles(descriptorFiles: string[]): string {
  if (descriptorFiles.length === 0) {
    return '<li><strong>Descriptor files:</strong> None configured</li>';
  }

  return descriptorFiles
    .map((descriptorFile) => `<li><strong>Descriptor file:</strong> <code>${escapeHtml(descriptorFile)}</code></li>`)
    .join('');
}

function renderChecks(checks: ProfileHealthCheck[]): string {
  if (checks.length === 0) {
    return '<em>None</em>';
  }

  const colorByStatus: Record<CheckStatus, string> = {
    ok: '#0f766e',
    error: '#b91c1c',
    skipped: '#92400e'
  };

  return `<ul>${checks.map((check) => {
    const detail = check.status === 'ok'
      ? escapeHtml(check.detail ?? 'Check succeeded.')
      : check.status === 'error'
        ? escapeHtml(check.error?.message ?? 'Check failed.')
        : escapeHtml(check.skippedReason ?? 'Check was skipped.');

    return `<li><strong>${escapeHtml(check.label)}:</strong> <span style="color:${colorByStatus[check.status]};font-weight:bold;">${escapeHtml(check.status)}</span><br><code>${escapeHtml(check.command)}</code><br><small>${detail}</small></li>`;
  }).join('')}</ul>`;
}

export function renderStatusPage(summary: ServiceHealthSummary): string {
  const statusColor = summary.status === 'ok' ? '#0f766e' : '#b91c1c';
  const profileRows = summary.profiles.length > 0
    ? summary.profiles.map((profile) => `
        <tr>
          <td>${escapeHtml(profile.id)}</td>
          <td>${profile.enabled ? '<strong>Enabled</strong>' : '<strong>Not enabled</strong>'}${!profile.configured ? '<br><small>Not defined in active YAML</small>' : ''}</td>
          <td>${escapeHtml(profile.mode)}</td>
          <td>${escapeHtml(profile.dbTargetLabel)}</td>
          <td>${renderToolList(profile.tools)}</td>
          <td>${renderChecks(profile.checks)}</td>
          <td>${renderModeSignals(profile.modeSignals)}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="7">No profiles are available.</td></tr>';

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

    <h2>Profiles</h2>
    <table>
      <thead>
        <tr>
          <th>Profile</th>
          <th>State</th>
          <th>Mode</th>
          <th>DB target</th>
          <th>Tools</th>
          <th>Checks</th>
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
