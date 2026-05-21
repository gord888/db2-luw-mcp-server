import { createAuditLogger, createLogger } from './audit/auditLogger.js';
import { loadConfig, resolveConfigPath } from './config/loadConfig.js';
import { DefaultDb2ClientFactory } from './db2/IbmDb2Client.js';
import { loadDescriptorCatalog } from './descriptors/descriptorCatalog.js';
import { createHttpServer } from './server/httpServer.js';

async function main(): Promise<void> {
  const logger = createLogger();
  const configPath = resolveConfigPath(process.argv.slice(2));
  const config = await loadConfig(configPath);
  const descriptorCatalog = await loadDescriptorCatalog(config.descriptorFiles);
  const server = createHttpServer({
    config,
    descriptorCatalog,
    db2ClientFactory: new DefaultDb2ClientFactory(),
    auditLogger: createAuditLogger(logger)
  });

  server.listen(config.server.port, config.server.host, () => {
    logger.info({
      eventType: 'startup',
      host: config.server.host,
      port: config.server.port,
      profileIds: Object.values(config.profiles).filter((profile) => profile.enabled).map((profile) => profile.id)
    }, 'DB2 LUW MCP server listening');
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
