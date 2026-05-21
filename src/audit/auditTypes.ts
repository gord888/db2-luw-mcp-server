import type { AppErrorCode } from '../errors/AppError.js';

export type AuditOutcome = 'success' | 'denied' | 'error';

export interface AuditEvent {
  timestamp: string;
  requestId: string;
  profileId: string;
  mode: string;
  toolName: string;
  dbTarget: string;
  normalizedObjectNames?: string[];
  sqlHash?: string;
  rowCount?: number;
  truncated?: boolean;
  durationMs: number;
  outcome: AuditOutcome;
  errorCode?: AppErrorCode;
}
