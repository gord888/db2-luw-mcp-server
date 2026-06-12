import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { AuditLogger } from '../audit/auditLogger.js';
import type { ResolvedConfig } from '../config/types.js';
import type { Db2ClientFactory } from '../db2/Db2Client.js';
import type { DescriptorCatalog } from '../descriptors/descriptorCatalog.js';
import { AppError } from '../errors/AppError.js';
import { toAppError, toErrorPayload } from '../errors/errorMapper.js';
import { authenticateRequest } from './auth.js';
import { collectServiceHealthSummary, renderStatusPage } from './healthStatus.js';
import {
  getDescriptorDir,
  handleDescriptorsDelete,
  handleDescriptorsGet,
  handleDescriptorsPost,
  handleDescriptorsPut,
  listDescriptorFiles,
  renderDescriptorPage
} from './descriptorManager.js';
import { createMcpServer } from './mcpServer.js';
import { createRequestContext } from './requestContext.js';

export interface HttpServerDependencies {
  config: ResolvedConfig;
  descriptorCatalog: DescriptorCatalog;
  db2ClientFactory: Db2ClientFactory;
  auditLogger: AuditLogger;
}

const MCP_METHODS = new Set(['GET', 'POST', 'DELETE']);

function setIncomingRawHeader(req: IncomingMessage, headerName: string, value: string): void {
  const normalizedHeaderName = headerName.toLowerCase();

  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === normalizedHeaderName) {
      req.rawHeaders[index + 1] = value;
      return;
    }
  }

  req.rawHeaders.push(headerName, value);
}

function normalizeMcpAcceptHeader(req: IncomingMessage): void {
  const method = req.method ?? 'GET';
  if (!MCP_METHODS.has(method)) {
    return;
  }

  const existingAcceptHeader = req.headers.accept;
  const firstValue = Array.isArray(existingAcceptHeader) ? existingAcceptHeader[0] : existingAcceptHeader;
  const acceptsJson = firstValue?.includes('application/json') ?? false;
  const acceptsEventStream = firstValue?.includes('text/event-stream') ?? false;

  if (acceptsJson && acceptsEventStream) {
    return;
  }

  req.headers.accept = 'application/json, text/event-stream';
  setIncomingRawHeader(req, 'Accept', 'application/json, text/event-stream');
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

function writeHtml(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(body);
}

export { writeHtml };

async function handleReadiness(
  res: ServerResponse,
  dependencies: HttpServerDependencies
): Promise<void> {
  const summary = await collectServiceHealthSummary(dependencies.config, dependencies.db2ClientFactory);

  writeJson(res, summary.status === 'ok' ? 200 : 503, {
    ...summary,
    status: summary.status === 'ok' ? 'ready' : 'degraded'
  });
}

async function handleHealth(
  res: ServerResponse,
  dependencies: HttpServerDependencies
): Promise<void> {
  const summary = await collectServiceHealthSummary(dependencies.config, dependencies.db2ClientFactory);

  writeJson(res, summary.status === 'ok' ? 200 : 503, summary);
}

async function handleStatusPage(
  res: ServerResponse,
  dependencies: HttpServerDependencies
): Promise<void> {
  const summary = await collectServiceHealthSummary(dependencies.config, dependencies.db2ClientFactory, {
    includeDetailedChecks: true
  });
  writeHtml(res, 200, renderStatusPage(summary));
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  dependencies: HttpServerDependencies
): Promise<void> {
  normalizeMcpAcceptHeader(req);

  authenticateRequest(req.headers, dependencies.config);
  const requestContext = createRequestContext(dependencies.config, req.method ?? 'POST', req.url ?? '/mcp');
  const requestBody = (req.method ?? 'GET') === 'POST'
    ? await readJsonBody(req, dependencies.config.limits.requestBodyBytes)
    : undefined;
  const server = createMcpServer({
    config: dependencies.config,
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
      const requestUrl = req.url ?? '/';
      const requestPath = requestUrl.split('?')[0] ?? '/';
      const requestMethod = req.method ?? 'GET';
      const isMcpRoute = requestPath === '/mcp' || requestPath === '/';

      if ((req.method ?? 'GET') === 'GET' && req.url === '/healthz') {
        await handleHealth(res, dependencies);
        return;
      }

      if ((req.method ?? 'GET') === 'GET' && req.url === '/readyz') {
        await handleReadiness(res, dependencies);
        return;
      }

      if ((req.method ?? 'GET') === 'GET' && req.url === '/status') {
        await handleStatusPage(res, dependencies);
        return;
      }

      if (requestPath === '/descriptors' && requestMethod === 'GET') {
        const descriptorDir = await getDescriptorDir(dependencies.config);
        const files = await listDescriptorFiles(dependencies.config.descriptorFiles, descriptorDir);
        writeHtml(res, 200, renderDescriptorPage(files, dependencies.config.server.publicBaseUrl, dependencies.config.apiKey));
        return;
      }

      if (requestPath === '/api/descriptors') {
        authenticateRequest(req.headers, dependencies.config);
        if (requestMethod === 'GET') {
          await handleDescriptorsGet(req, res, dependencies.config);
          return;
        }
        if (requestMethod === 'POST') {
          const body = await readJsonBody(req, dependencies.config.limits.requestBodyBytes);
          await handleDescriptorsPost(req, res, dependencies.config, dependencies.descriptorCatalog, body as { filename?: string; content?: string });
          return;
        }
        if (requestMethod === 'PUT') {
          const body = await readJsonBody(req, dependencies.config.limits.requestBodyBytes);
          await handleDescriptorsPut(req, res, dependencies.config, dependencies.descriptorCatalog, body as { path?: string; content?: string });
          return;
        }
        if (requestMethod === 'DELETE') {
          await handleDescriptorsDelete(req, res, dependencies.config, dependencies.descriptorCatalog);
          return;
        }
        res.setHeader('Allow', 'GET, POST, PUT, DELETE');
        writeJson(res, 405, { error: 'Method Not Allowed' });
        return;
      }

      if (isMcpRoute && MCP_METHODS.has(requestMethod)) {
        await handleMcp(req, res, dependencies);
        return;
      }

      if (isMcpRoute) {
        res.setHeader('Allow', 'GET, POST, DELETE');
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
