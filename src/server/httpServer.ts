import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { AuditLogger } from '../audit/auditLogger.js';
import type { ResolvedConfig } from '../config/types.js';
import type { Db2ClientFactory } from '../db2/Db2Client.js';
import type { DescriptorCatalog } from '../descriptors/descriptorCatalog.js';
import { AppError } from '../errors/AppError.js';
import { toAppError, toErrorPayload } from '../errors/errorMapper.js';
import { authenticateRequest } from './auth.js';
import { createMcpServer } from './mcpServer.js';
import { createRequestContext } from './requestContext.js';

export interface HttpServerDependencies {
  config: ResolvedConfig;
  descriptorCatalog: DescriptorCatalog;
  db2ClientFactory: Db2ClientFactory;
  auditLogger: AuditLogger;
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new AppError('VALIDATION_ERROR', `Request body exceeded ${maxBytes} bytes.`, 413));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        resolve(rawBody ? JSON.parse(rawBody) : {});
      } catch (error) {
        reject(new AppError('VALIDATION_ERROR', 'Request body must be valid JSON.', 400, error));
      }
    });

    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function handleReadiness(
  req: IncomingMessage,
  res: ServerResponse,
  dependencies: HttpServerDependencies
): Promise<void> {
  if (dependencies.config.server.readinessAuthRequired) {
    authenticateRequest(req.headers, dependencies.config);
  }

  const enabledProfiles = Object.values(dependencies.config.profiles).filter((profile) => profile.enabled);

  for (const profile of enabledProfiles) {
    const client = dependencies.db2ClientFactory.create(profile);

    try {
      await client.testConnection();
    } finally {
      await client.close();
    }
  }

  writeJson(res, 200, {
    status: 'ready',
    profiles: enabledProfiles.map((profile) => profile.id)
  });
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  dependencies: HttpServerDependencies
): Promise<void> {
  const profile = authenticateRequest(req.headers, dependencies.config);
  const requestContext = createRequestContext(profile, req.method ?? 'POST', req.url ?? '/mcp');
  const requestBody = await readJsonBody(req, dependencies.config.limits.requestBodyBytes);
  const server = createMcpServer({
    config: dependencies.config,
    profile,
    descriptorCatalog: dependencies.descriptorCatalog,
    db2ClientFactory: dependencies.db2ClientFactory,
    auditLogger: dependencies.auditLogger,
    requestContext
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, requestBody);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

export function createHttpServer(dependencies: HttpServerDependencies): Server {
  return createServer(async (req, res) => {
    try {
      if ((req.method ?? 'GET') === 'GET' && req.url === '/healthz') {
        writeJson(res, 200, {
          status: 'ok'
        });
        return;
      }

      if ((req.method ?? 'GET') === 'GET' && req.url === '/readyz') {
        await handleReadiness(req, res, dependencies);
        return;
      }

      if ((req.method ?? 'POST') === 'POST' && req.url === '/mcp') {
        await handleMcp(req, res, dependencies);
        return;
      }

      if (req.url === '/mcp') {
        res.setHeader('Allow', 'POST');
        writeJson(res, 405, {
          error: 'Method Not Allowed'
        });
        return;
      }

      writeJson(res, 404, {
        error: 'Not Found'
      });
    } catch (error) {
      const appError = toAppError(error);
      const requestId = 'requestId' in (error as object) ? String((error as { requestId?: unknown }).requestId ?? '') : 'unavailable';
      writeJson(res, appError.statusCode, toErrorPayload(appError, requestId));
    }
  });
}
