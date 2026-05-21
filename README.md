# DB2 LUW MCP Server

Standalone internal MCP server for IBM DB2 LUW. Release 1 is HTTP-first, profile-driven, and uses direct `ibm_db` connectivity with guarded read-only query support plus allowlisted stored procedures.

## What it includes

- `POST /mcp` MCP endpoint over Streamable HTTP
- `GET /healthz` and `GET /readyz`
- API-key-to-profile auth with per-profile DB credentials
- Read-only metadata/query tools plus allowlisted stored procedure execution
- Descriptor catalog support for business aliases and join hints
- Structured audit logging with `pino`
- Linux container packaging and Azure DevOps YAML build pipeline

## Quick start

1. Copy `.env.example` values into your environment.
2. Set `DB2_MCP_CONFIG_PATH` to a profile YAML file.
3. Install dependencies with `npm ci`.
4. Start locally with `npm run dev`.

## Commands

- `npm run build`
- `npm run test`
- `npm run dev`
- `npm run dev:stdio`
- `npm start`
- `npm run start:stdio`

## Configuration

The server expects a YAML config file whose path is provided through `DB2_MCP_CONFIG_PATH`. The sample file is `config/profiles.example.yaml`.

Secrets are loaded from environment variables referenced by the config file:

- API keys via `apiKeyEnv`
- DB2 connection strings via `connectionStringEnv`

Descriptor catalogs are optional. Invalid descriptor files fail startup; missing descriptor files only fail startup when explicitly configured.

## HTTP endpoints

- `GET /healthz` returns process health.
- `GET /readyz` validates DB connectivity for enabled profiles.
- `POST /mcp` accepts MCP requests authenticated with `Authorization: Bearer <api-key>`.

## Local run example

```powershell
$env:DB2_MCP_CONFIG_PATH = ".\config\profiles.example.yaml"
$env:DB2_MCP_API_KEY_READONLY = "readonly-key"
$env:DB2_MCP_API_KEY_READONLY_PROCEDURES = "readonly-proc-key"
$env:DB2_MCP_API_KEY_FULL = "full-key"
$env:DB2_MCP_DB_READONLY = "DATABASE=SAMPLE;HOSTNAME=db2.internal;PORT=50000;PROTOCOL=TCPIP;UID=db2_mcp_ro;PWD=secret;"
$env:DB2_MCP_DB_READONLY_PROCEDURES = "DATABASE=SAMPLE;HOSTNAME=db2.internal;PORT=50000;PROTOCOL=TCPIP;UID=db2_mcp_ro_proc;PWD=secret;"
$env:DB2_MCP_DB_FULL = "DATABASE=SAMPLE;HOSTNAME=db2.internal;PORT=50000;PROTOCOL=TCPIP;UID=db2_mcp_full;PWD=secret;"
npm run dev
```

## Readonly startup script

To start the server with only the readonly profile configured, use:

```powershell
.\scripts\start-readonly-mcp.ps1 `
  -ReadonlyApiKey "readonly-key" `
  -ReadonlyConnectionString "DATABASE=SAMPLE;HOSTNAME=db2.internal;PORT=50000;PROTOCOL=TCPIP;UID=db2_mcp_ro;PWD=secret;"
```

The script points `DB2_MCP_CONFIG_PATH` at `config\profiles.readonly.yaml`, so you do not need to provide the `readonly_procedures` or `full` profile environment variables.

## Windows local testing

For local Windows HTTP testing:

```powershell
Set-Location C:\path\to\db2-luw-mcp-server
npm ci

.\scripts\start-readonly-mcp.ps1 `
  -ReadonlyApiKey "readonly-key" `
  -ReadonlyConnectionString "DATABASE=SAMPLE;HOSTNAME=db2.internal;PORT=50000;PROTOCOL=TCPIP;UID=db2_mcp_ro;PWD=secret;"
```

For local MCP stdio testing without the HTTP/OAuth flow:

```powershell
Set-Location C:\path\to\db2-luw-mcp-server
npm ci

.\scripts\start-readonly-stdio-mcp.ps1 `
  -ReadonlyConnectionString "DATABASE=SAMPLE;HOSTNAME=db2.internal;PORT=50000;PROTOCOL=TCPIP;UID=db2_mcp_ro;PWD=secret;"
```

To run the same stdio server through `npx` without needing a registry or GitHub auth, package it locally and launch from the tarball:

```powershell
Set-Location C:\path\to\db2-luw-mcp-server

.\scripts\start-readonly-stdio-npx.ps1 `
  -ReadonlyConnectionString "DATABASE=SAMPLE;HOSTNAME=db2.internal;PORT=50000;PROTOCOL=TCPIP;UID=db2_mcp_ro;PWD=secret;"
```

When the config file enables exactly one profile, stdio mode selects it automatically. If multiple profiles are enabled, pass `--profile=<profile-id>`.

## npx and local command setup

The package now exposes a stdio executable named `db2-luw-mcp-server`. That lets MCP clients launch it as a local command instead of connecting over HTTP, which avoids the OAuth/browser flow used by remote MCP endpoints.

For local development on Windows, the simplest path is:

```powershell
Set-Location C:\path\to\db2-luw-mcp-server
npm ci
npm link
```

After that, your MCP client can launch the linked command directly:

```json
{
  "mcpServers": {
    "db2-readonly": {
      "command": "db2-luw-mcp-server",
      "args": [
        "--profile=readonly",
        "--config=C:\\path\\to\\db2-luw-mcp-server\\config\\profiles.readonly.yaml"
      ],
      "env": {
        "DB2_MCP_DB_READONLY": "DATABASE=SAMPLE;HOSTNAME=db2.internal;PORT=50000;PROTOCOL=TCPIP;UID=db2_mcp_ro;PWD=secret;",
        "DB2_MCP_API_KEY_READONLY": "stdio-local-readonly"
      }
    }
  }
}
```

If you later publish the package to a registry, the same setup can use `npx`:

```json
{
  "mcpServers": {
    "db2-readonly": {
      "command": "npx",
      "args": [
        "-y",
        "db2-luw-mcp-server",
        "--profile=readonly",
        "--config=C:\\path\\to\\db2-luw-mcp-server\\config\\profiles.readonly.yaml"
      ],
      "env": {
        "DB2_MCP_DB_READONLY": "DATABASE=SAMPLE;HOSTNAME=db2.internal;PORT=50000;PROTOCOL=TCPIP;UID=db2_mcp_ro;PWD=secret;",
        "DB2_MCP_API_KEY_READONLY": "stdio-local-readonly"
      }
    }
  }
}
```

For local-only testing, you can also run `npx` from a local tarball with no registry at all:

```powershell
Set-Location C:\path\to\db2-luw-mcp-server
$pkg = npm pack | Select-Object -Last 1

npx --yes --package ".\$pkg" db2-luw-mcp-server `
  --profile=readonly `
  --config=C:\path\to\db2-luw-mcp-server\config\profiles.readonly.yaml
```

If you keep the code only in a private GitHub repository, fetching directly from that private repo still requires GitHub authentication to download the code. The clean workaround is either:

- use the local tarball `npx` flow above for testing
- or publish the package to a registry your machine can already authenticate to

## Client example

Configure your MCP client to call:

- URL: `http://localhost:3000/mcp`
- Header: `Authorization: Bearer <api-key>`

## Notes

- Query responses are capped at 1000 rows.
- `run_query` accepts read-only SQL only.
- `call_procedure` is available only in `readonly_procedures` profiles and requires an exact allowlist match.
