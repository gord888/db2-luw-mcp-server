import { AppError, type AppErrorCode } from './AppError.js';

export interface ErrorPayload extends Record<string, unknown> {
  code: AppErrorCode;
  message: string;
  requestId: string;
}

export function toAppError(error: unknown, fallbackCode: AppErrorCode = 'DB_EXECUTION_FAILED'): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError(fallbackCode, error.message, 500, { cause: error.name });
  }

  return new AppError(fallbackCode, 'Unexpected error.', 500, { cause: error });
}

export function toErrorPayload(error: AppError, requestId: string): ErrorPayload {
  return {
    code: error.code,
    message: error.message,
    requestId
  };
}

export function isDeniedError(error: AppError): boolean {
  return error.code === 'AUTH_INVALID'
    || error.code === 'AUTH_MISSING'
    || error.code === 'PROFILE_DISABLED'
    || error.code === 'TOOL_NOT_ALLOWED'
    || error.code === 'SQL_NOT_READONLY'
    || error.code === 'SQL_TOO_COMPLEX'
    || error.code === 'PROCEDURE_NOT_ALLOWLISTED';
}
