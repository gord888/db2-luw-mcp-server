import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';

import { authenticateRequest } from '../src/server/auth.js';
import type { ResolvedConfig } from '../src/config/types.js';
import { AppError } from '../src/errors/AppError.js';

function createConfig(): ResolvedConfig {
  return {
    mode: 'readonly',
    apiKey: 'readonly-key',
    apiKeyHash: 'hash',
    callerLabel: 'readonly',
    dbLabel: 'readonly-db',
    connectionString: 'DATABASE=SAMPLE;',
    tools: ['run_query'],
    procedureAllowlist: [],
    server: {
      host: '127.0.0.1',
      port: 3000
    },
    limits: {
      maxRows: 1000,
      defaultPreviewRows: 50,
      queryTimeoutMs: 30000,
      metadataTimeoutMs: 15000,
      requestBodyBytes: 1048576
    },
    descriptorFiles: []
  };
}

describe('authenticateRequest', () => {
  it('accepts valid bearer keys without throwing', () => {
    const headers: IncomingHttpHeaders = {
      authorization: 'Bearer readonly-key'
    };

    expect(() => authenticateRequest(headers, createConfig())).not.toThrow();
  });

  it('rejects unknown keys', () => {
    const headers: IncomingHttpHeaders = {
      authorization: 'Bearer nope'
    };

    expect(() => authenticateRequest(headers, createConfig())).toThrowError(AppError);
  });

  it('rejects missing authorization header', () => {
    const headers: IncomingHttpHeaders = {};

    expect(() => authenticateRequest(headers, createConfig())).toThrowError(AppError);
  });

  it('rejects non-bearer authorization scheme', () => {
    const headers: IncomingHttpHeaders = {
      authorization: 'Basic readonly-key'
    };

    expect(() => authenticateRequest(headers, createConfig())).toThrowError(AppError);
  });
});
