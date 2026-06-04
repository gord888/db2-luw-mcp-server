import { createAuditLogger, createLogger } from './audit/auditLogger.js';
import { loadConfig } from './config/loadConfig.js';
import { DefaultDb2ClientFactory } from './db2/IbmDb2Client.js';
import { loadDescriptorCatalog } from './descriptors/descriptorCatalog.js';
import { createHttpServer } from './server/httpServer.js';

async function main(): Promise<void> {
  const logger = createLogger();
  const config = loadConfig();

  if (config.configErrors.length > 0) {
    logger.warn({
      eventType: 'config_errors',
      errors: config.configErrors
    }, 'Server starting with configuration errors — health checks will show degraded status.');
    for (const err of config.configErrors) {
      logger.warn({ variable: err.variable }, err.message);
    }
  }

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
      mode: config.mode
    }, 'DB2 LUW MCP server listening');
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
