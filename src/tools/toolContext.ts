import { createHash } from 'node:crypto';

import type { AuditLogger } from '../audit/auditLogger.js';
import type { ResolvedConfig, ResolvedProfileConfig } from '../config/types.js';
import type { Db2Client, Db2ClientFactory } from '../db2/Db2Client.js';
import type { DescriptorCatalog } from '../descriptors/descriptorCatalog.js';
import type { RequestContext } from '../server/requestContext.js';

export interface ToolServices {
  config: ResolvedConfig;
  profile: ResolvedProfileConfig;
  descriptorCatalog: DescriptorCatalog;
  db2ClientFactory: Db2ClientFactory;
  auditLogger: AuditLogger;
  requestContext: RequestContext;
}

export interface ToolExecutionPayload {
  data: unknown;
  rowCount?: number;
  truncated?: boolean;
  normalizedObjectNames?: string[];
  sqlHash?: string;
}

export async function withDbClient<T>(services: ToolServices, callback: (client: Db2Client) => Promise<T>): Promise<T> {
  const client = services.db2ClientFactory.create(services.profile);

  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}

export function createToolTextPayload(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function hashSql(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}
