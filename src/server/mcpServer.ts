import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerTools } from '../tools/registerTools.js';
import type { ToolServices } from '../tools/toolContext.js';

export function createMcpServer(services: ToolServices): McpServer {
  const server = new McpServer({
    name: 'db2-luw-mcp-server',
    version: '1.0.0'
  }, {
    capabilities: {
      logging: {}
    }
  });

  registerTools(server, services);

  return server;
}
