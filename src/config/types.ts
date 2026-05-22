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

export const FUTURE_TOOL_NAMES = [
  'insert_rows',
  'update_rows',
  'delete_rows',
  'upsert_rows',
  'run_sql_mutation',
  'execute_action',
  'collect_diagnostics'
] as const;

export const IMPLEMENTED_TOOL_NAMES = [
  ...READONLY_TOOL_NAMES,
  ...PROCEDURE_TOOL_NAMES,
  ...FULL_DDL_TOOL_NAMES
] as const;

export const TOOL_NAMES = [
  ...IMPLEMENTED_TOOL_NAMES,
  ...FUTURE_TOOL_NAMES
] as const;

export type ToolName = typeof TOOL_NAMES[number];
export type ImplementedToolName = typeof IMPLEMENTED_TOOL_NAMES[number];
export type AccessMode = 'readonly' | 'readonly_procedures' | 'full';

export interface ProcedureAllowlistEntry {
  schema: string;
  name: string;
}

export interface RawProfileConfig {
  enabled?: boolean;
  mode: AccessMode;
  apiKeyEnv: string;
  callerLabel?: string;
  db: {
    connectionStringEnv: string;
    targetLabel?: string;
  };
  tools: ToolName[];
  procedureAllowlist?: ProcedureAllowlistEntry[];
}

export interface RawConfig {
  server: {
    host: string;
    port: number;
    publicBaseUrl?: string;
    readinessAuthRequired?: boolean;
  };
  limits: {
    maxRows: number;
    defaultPreviewRows: number;
    queryTimeoutMs: number;
    metadataTimeoutMs: number;
    requestBodyBytes?: number;
  };
  descriptors?: {
    files?: string[];
  };
  profiles: Record<string, RawProfileConfig>;
}

export interface ResolvedProfileConfig {
  id: string;
  enabled: boolean;
  mode: AccessMode;
  apiKeyEnv: string;
  apiKey: string;
  apiKeyHash: string;
  callerLabel?: string;
  db: {
    connectionStringEnv: string;
    connectionString: string;
    targetLabel: string;
  };
  tools: ToolName[];
  procedureAllowlist: ProcedureAllowlistEntry[];
}

export interface ResolvedConfig {
  configPath: string;
  server: {
    host: string;
    port: number;
    publicBaseUrl?: string;
    readinessAuthRequired: boolean;
  };
  limits: {
    maxRows: number;
    defaultPreviewRows: number;
    queryTimeoutMs: number;
    metadataTimeoutMs: number;
    requestBodyBytes: number;
  };
  descriptorFiles: string[];
  profiles: Record<string, ResolvedProfileConfig>;
}
