import type { IncomingHttpHeaders } from 'node:http';

import type { ResolvedConfig } from '../config/types.js';
import { AppError } from '../errors/AppError.js';

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function extractBearerToken(headers: IncomingHttpHeaders): string {
  const authorization = readHeaderValue(headers.authorization);

  if (!authorization) {
    throw new AppError('AUTH_MISSING', 'Missing Authorization header.', 401);
  }

  const [scheme, token] = authorization.split(/\s+/, 2);

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new AppError('AUTH_INVALID', 'Authorization header must use Bearer authentication.', 401);
  }

  return token;
}

export function authenticateRequest(headers: IncomingHttpHeaders, config: ResolvedConfig): void {
  const token = extractBearerToken(headers);

  if (token !== config.apiKey) {
    throw new AppError('AUTH_INVALID', 'Invalid API key.', 401);
  }
}
