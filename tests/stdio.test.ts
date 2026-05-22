import { describe, expect, it } from 'vitest';

import type { ResolvedConfig } from '../src/config/types.js';
import { resolveStdioProfile } from '../src/stdio.js';

function createConfig(enabledProfileIds: string[]): ResolvedConfig {
  const createProfile = (id: string) => ({
    id,
    enabled: enabledProfileIds.includes(id),
    mode: id === 'readonly_procedures' ? 'readonly_procedures' as const : 'readonly' as const,
    apiKeyEnv: `API_KEY_${id.toUpperCase()}`,
    apiKey: `key-${id}`,
    apiKeyHash: `hash-${id}`,
    callerLabel: id,
    db: {
      connectionStringEnv: `DB_${id.toUpperCase()}`,
      connectionString: `DATABASE=${id};`,
      targetLabel: id
    },
    tools: ['run_query'] as const,
    procedureAllowlist: []
  });

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
      readonly: createProfile('readonly'),
      readonly_procedures: {
        ...createProfile('readonly_procedures'),
        tools: ['run_query', 'call_procedure']
      }
    }
  };
}

describe('resolveStdioProfile', () => {
  it('selects the only enabled profile automatically', () => {
    const profile = resolveStdioProfile([], createConfig(['readonly']));

    expect(profile.id).toBe('readonly');
  });

  it('requires an explicit profile when multiple profiles are enabled', () => {
    expect(() => resolveStdioProfile([], createConfig(['readonly', 'readonly_procedures']))).toThrow(
      /requires --profile/
    );
  });

  it('uses the requested enabled profile', () => {
    const profile = resolveStdioProfile(['--profile=readonly_procedures'], createConfig(['readonly', 'readonly_procedures']));

    expect(profile.id).toBe('readonly_procedures');
  });
});
