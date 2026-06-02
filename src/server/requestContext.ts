import { randomUUID } from 'node:crypto';

import type { ResolvedConfig } from '../config/types.js';

export interface RequestContext {
  requestId: string;
  startedAt: string;
  mode: ResolvedConfig['mode'];
  callerLabel: string;
  dbTargetLabel: string;
  method: string;
  path: string;
}

export function createRequestContext(config: ResolvedConfig, method: string, requestPath: string): RequestContext {
  return {
    requestId: randomUUID(),
    startedAt: new Date().toISOString(),
    mode: config.mode,
    callerLabel: config.callerLabel,
    dbTargetLabel: config.dbLabel,
    method,
    path: requestPath
  };
}
