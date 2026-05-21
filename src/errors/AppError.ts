export type AppErrorCode =
  | 'AUTH_MISSING'
  | 'AUTH_INVALID'
  | 'PROFILE_DISABLED'
  | 'TOOL_NOT_ALLOWED'
  | 'SQL_NOT_READONLY'
  | 'SQL_TOO_COMPLEX'
  | 'PROCEDURE_NOT_ALLOWLISTED'
  | 'VALIDATION_ERROR'
  | 'DB_TIMEOUT'
  | 'DB_CONNECTION_FAILED'
  | 'DB_EXECUTION_FAILED'
  | 'CONFIG_INVALID';

export class AppError extends Error {
  public readonly code: AppErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;

  public constructor(code: AppErrorCode, message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}
