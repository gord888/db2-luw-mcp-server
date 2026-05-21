import pino, { type Logger } from 'pino';

import type { AuditEvent } from './auditTypes.js';

export interface AuditLogger {
  logToolEvent(event: AuditEvent): void;
}

export class PinoAuditLogger implements AuditLogger {
  public constructor(private readonly logger: Logger) {}

  public logToolEvent(event: AuditEvent): void {
    this.logger.info({
      eventType: 'mcp_tool_invocation',
      ...event
    });
  }
}

export class MemoryAuditLogger implements AuditLogger {
  public readonly events: AuditEvent[] = [];

  public logToolEvent(event: AuditEvent): void {
    this.events.push(event);
  }
}

export function createLogger(): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info'
  });
}

export function createStdioLogger(): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info'
  }, pino.destination(2));
}

export function createAuditLogger(logger?: Logger): AuditLogger {
  return new PinoAuditLogger(logger ?? createLogger());
}
