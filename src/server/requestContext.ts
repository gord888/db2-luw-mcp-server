import { randomUUID } from 'node:crypto';

import type { ResolvedProfileConfig } from '../config/types.js';

export interface RequestContext {
  requestId: string;
  startedAt: string;
  profileId: string;
  mode: ResolvedProfileConfig['mode'];
  callerLabel?: string;
  dbTargetLabel: string;
  method: string;
  path: string;
}

export function createRequestContext(profile: ResolvedProfileConfig, method: string, requestPath: string): RequestContext {
  return {
    requestId: randomUUID(),
    startedAt: new Date().toISOString(),
    profileId: profile.id,
    mode: profile.mode,
    callerLabel: profile.callerLabel,
    dbTargetLabel: profile.db.targetLabel,
    method,
    path: requestPath
  };
}
