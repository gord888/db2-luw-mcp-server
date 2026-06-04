export const READONLY_TOOL_NAMES = [
  'list_schemas',
  'list_tables',
  'describe_table',
  'describe_index',
  'get_relationships',
  'get_table_context',
  'search_business_terms',
  'list_join_paths',
  'search_objects',
  'run_query',
  'preview_table',
  'explain_query'
] as const;

export const PROCEDURE_TOOL_NAMES = [
  'list_procedures',
  'describe_procedure',
  'call_procedure'
] as const;

export const FULL_DDL_TOOL_NAMES = [
  'run_ddl',
  'deploy_procedure',
  'drop_procedure',
  'deploy_function',
  'drop_function',
  'deploy_view',
  'drop_view'
] as const;

export const IMPLEMENTED_TOOL_NAMES = [
  ...READONLY_TOOL_NAMES,
  ...PROCEDURE_TOOL_NAMES,
  ...FULL_DDL_TOOL_NAMES
] as const;

export type ToolName = typeof IMPLEMENTED_TOOL_NAMES[number];
export type ImplementedToolName = typeof IMPLEMENTED_TOOL_NAMES[number];
export type AccessMode = 'readonly' | 'readonly_procedures' | 'full';

const MODE_TOOL_MAP: Record<AccessMode, ToolName[]> = {
  readonly: [...READONLY_TOOL_NAMES],
  readonly_procedures: [...READONLY_TOOL_NAMES, ...PROCEDURE_TOOL_NAMES],
  full: [...READONLY_TOOL_NAMES, ...PROCEDURE_TOOL_NAMES, ...FULL_DDL_TOOL_NAMES]
};

export function getToolsForMode(mode: AccessMode): ToolName[] {
  return MODE_TOOL_MAP[mode];
}

export interface ConfigError {
  variable: string;
  message: string;
}

export interface ProcedureAllowlistEntry {
  schema: string;
  name: string;
}

export interface ResolvedConfig {
  mode: AccessMode;
  apiKey: string;
  apiKeyHash: string;
  callerLabel: string;
  dbLabel: string;
  connectionString: string;
  tools: ToolName[];
  procedureAllowlist: ProcedureAllowlistEntry[];
  server: {
    host: string;
    port: number;
    publicBaseUrl?: string;
  };
  limits: {
    maxRows: number;
    defaultPreviewRows: number;
    queryTimeoutMs: number;
    metadataTimeoutMs: number;
    requestBodyBytes: number;
  };
  descriptorFiles: string[];
  configErrors: ConfigError[];
}
