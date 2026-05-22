import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';

import { authenticateRequest } from '../src/server/auth.js';
import type { ResolvedConfig } from '../src/config/types.js';
import { AppError } from '../src/errors/AppError.js';

function createConfig(): ResolvedConfig {
  return {
    configPath: '/test/config.yaml',
    server: {
      host: '127.0.0.1',
      port: 3000,
      readinessAuthRequired: true
    },
    limits: {
      maxRows: 1000,
      defaultPreviewRows: 50,
      queryTimeoutMs: 30000,
      metadataTimeoutMs: 15000,
      requestBodyBytes: 1024 * 1024
    },
    descriptorFiles: [],
    profiles: {
      readonly: {
        id: 'readonly',
        enabled: true,
        mode: 'readonly',
        apiKeyEnv: 'READONLY_KEY',
        apiKey: 'readonly-key',
        apiKeyHash: 'hash',
        db: {
          connectionStringEnv: 'READONLY_DB',
          connectionString: 'DATABASE=SAMPLE;',
          targetLabel: 'readonly'
        },
        tools: ['run_query'],
        procedureAllowlist: []
      }
    }
  };
}

describe('authenticateRequest', () => {
  it('maps bearer keys to a single profile', () => {
    const headers: IncomingHttpHeaders = {
      authorization: 'Bearer readonly-key'
    };

    const profile = authenticateRequest(headers, createConfig());

    expect(profile.id).toBe('readonly');
  });

  it('rejects unknown keys', () => {
    const headers: IncomingHttpHeaders = {
      authorization: 'Bearer nope'
    };

    expect(() => authenticateRequest(headers, createConfig())).toThrowError(AppError);
  });
});
