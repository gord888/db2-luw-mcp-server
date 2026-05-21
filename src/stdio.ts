import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createAuditLogger, createStdioLogger } from './audit/auditLogger.js';
import { loadConfig, resolveConfigPath } from './config/loadConfig.js';
import type { ResolvedConfig, ResolvedProfileConfig } from './config/types.js';
import { DefaultDb2ClientFactory } from './db2/IbmDb2Client.js';
import { loadDescriptorCatalog } from './descriptors/descriptorCatalog.js';
import { AppError } from './errors/AppError.js';
import { createRequestContext } from './server/requestContext.js';
import { createMcpServer } from './server/mcpServer.js';

function getArgumentValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inlineArgument = argv.find((value) => value.startsWith(prefix));
  if (inlineArgument) {
    return inlineArgument.slice(prefix.length);
  }

  const argumentIndex = argv.indexOf(`--${name}`);
  if (argumentIndex >= 0) {
    return argv[argumentIndex + 1];
  }

  return undefined;
}

export function resolveStdioProfile(argv: string[], config: ResolvedConfig): ResolvedProfileConfig {
  const requestedProfileId = getArgumentValue(argv, 'profile') ?? process.env.DB2_MCP_PROFILE_ID;
  const enabledProfiles = Object.values(config.profiles).filter((profile) => profile.enabled);

  if (requestedProfileId) {
    const requestedProfile = config.profiles[requestedProfileId];
    if (!requestedProfile) {
      throw new AppError('CONFIG_INVALID', `Profile ${requestedProfileId} does not exist in the loaded configuration.`, 500);
    }

    if (!requestedProfile.enabled) {
      throw new AppError('CONFIG_INVALID', `Profile ${requestedProfileId} is disabled and cannot be used for stdio mode.`, 500);
    }

    return requestedProfile;
  }

  if (enabledProfiles.length === 1) {
    const [onlyEnabledProfile] = enabledProfiles;
    if (!onlyEnabledProfile) {
      throw new AppError('CONFIG_INVALID', 'No enabled profiles are available for stdio mode.', 500);
    }

    return onlyEnabledProfile;
  }

  throw new AppError(
    'CONFIG_INVALID',
    `Stdio mode requires --profile when multiple profiles are enabled. Enabled profiles: ${enabledProfiles.map((profile) => profile.id).join(', ')}.`,
    500
  );
}

export async function main(): Promise<void> {
  const logger = createStdioLogger();
  const argv = process.argv.slice(2);
  const configPath = resolveConfigPath(argv);
  const config = await loadConfig(configPath, {
    requireApiKeys: false
  });
  const descriptorCatalog = await loadDescriptorCatalog(config.descriptorFiles);
  const profile = resolveStdioProfile(argv, config);
  const server = createMcpServer({
    config,
    profile,
    descriptorCatalog,
    db2ClientFactory: new DefaultDb2ClientFactory(),
    auditLogger: createAuditLogger(logger),
    requestContext: createRequestContext(profile, 'STDIO', '/stdio')
  });
  const transport = new StdioServerTransport();

  logger.info({
    eventType: 'startup',
    transport: 'stdio',
    profileId: profile.id
  }, 'DB2 LUW MCP stdio server listening');

  await server.connect(transport);
}

function isExecutedDirectly(): boolean {
  const entryPoint = process.argv[1];
  if (!entryPoint) {
    return false;
  }

  return import.meta.url === pathToFileURL(entryPoint).href;
}

if (isExecutedDirectly()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
