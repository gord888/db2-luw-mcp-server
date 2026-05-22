import type { ResolvedProfileConfig } from '../config/types.js';

export type Db2Scalar = string | number | boolean | null;

export interface Db2DirectionalParameter {
  direction: 'input' | 'output' | 'inout';
  value: Db2Scalar;
  sqlType?: string;
  cType?: string;
  length?: number;
}

export type Db2Parameter = Db2Scalar | Db2DirectionalParameter;

export interface QueryOptions {
  timeoutMs: number;
  label?: string;
}

export interface QueryResult<T = Record<string, unknown>> {
  columns: string[];
  rows: T[];
  rowCount: number;
  warnings: string[];
}

export interface ProcedureResult extends Record<string, unknown> {
  rows: Record<string, unknown>[];
  rowCount: number;
  outputParameters: Record<string, unknown>;
  warnings: string[];
}

export interface MetadataOptions {
  timeoutMs: number;
}

export interface DatabaseMetadata {
  schemas: Array<{ schema: string }>;
  tables: Array<{ schema: string; table: string; type?: string }>;
  procedures: Array<{ schema: string; procedure: string }>;
}

export interface ExplainResult extends Record<string, unknown> {
  statementText: string;
  details: Record<string, unknown>[];
}

export interface Db2Client {
  query<T = Record<string, unknown>>(sql: string, params: Db2Parameter[], options: QueryOptions): Promise<QueryResult<T>>;
  callProcedure(schema: string, name: string, params: Db2Parameter[], options: QueryOptions): Promise<ProcedureResult>;
  getMetadata(options: MetadataOptions): Promise<DatabaseMetadata>;
  explain(sql: string, params: Db2Parameter[], options: QueryOptions): Promise<ExplainResult>;
  testConnection(): Promise<void>;
  close(): Promise<void>;
}

export interface Db2ClientFactory {
  create(profile: ResolvedProfileConfig): Db2Client;
}
