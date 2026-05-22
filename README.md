# DB2 LUW MCP Server

Standalone internal MCP server for IBM DB2 LUW. Release 1 is HTTP-first, profile-driven, and uses direct `ibm_db` connectivity with guarded read-only query support plus allowlisted stored procedures.

## What it includes

- Streamable HTTP MCP endpoint at `/mcp`
- Compatibility alias at `/` for simpler MCP HTTP clients
- `GET /healthz` and `GET /readyz`
- API-key-to-profile auth with per-profile DB credentials
- Read-only metadata/query tools plus allowlisted stored procedure execution
- Optional stdio entrypoint for local `npx` / linked-command use
- Linux container packaging and Azure DevOps pipeline assets

## Repository contents

| Path | Purpose |
| --- | --- |
| `.env.example` | Environment variable reference with all profile secrets |
| `config\profiles.readonly.yaml` | Readonly-only config |
| `config\profiles.readonly-procedures.yaml` | Readonly-with-stored-procedures-only config |
| `config\profiles.full.yaml` | Full-profile-only config stub |
| `config\profiles.example.yaml` | All profiles defined in one file |
| `config\descriptors.example.yaml` | Example descriptor catalog |
| `scripts\deploy-linux-mcp.sh` | Linux container / VM deployment script |
| `scripts\start-readonly-mcp.ps1` | Windows local HTTP starter |
| `scripts\start-readonly-stdio-mcp.ps1` | Windows local stdio starter |
| `scripts\start-readonly-stdio-npx.ps1` | Windows local tarball `npx` starter |

## Commands

- `npm run build`
- `npm run test`
- `npm run dev`
- `npm run dev:stdio`
- `npm start`
- `npm run start:stdio`

## HTTP endpoints

- `GET /healthz` returns process health
- `GET /readyz` validates DB connectivity for enabled profiles and requires a valid bearer token when `readinessAuthRequired: true`
- `GET /mcp`, `POST /mcp`, and `DELETE /mcp` handle MCP Streamable HTTP traffic
- `GET /`, `POST /`, and `DELETE /` are accepted as an MCP alias for simpler clients and bridge tools

## Configuration files

The server reads its active YAML file from `DB2_MCP_CONFIG_PATH`.

### YAML files in the repo

- `config/profiles.readonly.yaml`
- `config/profiles.readonly-procedures.yaml`
- `config/profiles.full.yaml`
- `config/profiles.example.yaml`
- `config/descriptors.example.yaml`

### Runtime environment variables

The server resolves secrets from environment variables named by the YAML file:

- `DB2_MCP_API_KEY_READONLY`
- `DB2_MCP_DB_READONLY`
- `DB2_MCP_API_KEY_READONLY_PROCEDURES`
- `DB2_MCP_DB_READONLY_PROCEDURES`
- `DB2_MCP_API_KEY_FULL`
- `DB2_MCP_DB_FULL`
- `LOG_LEVEL`

For Linux deployments in this repo, the runtime env file is typically:

```text
/etc/db2-luw-mcp-server.env
```

### How to enable and disable modes

Use one of the mode-specific YAML files, or edit `config/profiles.example.yaml`.

#### Readonly mode

Use:

```text
config/profiles.readonly.yaml
```

or in `config/profiles.example.yaml` set:

```yaml
profiles:
  readonly:
    enabled: true
  readonly_procedures:
    enabled: false
  full:
    enabled: false
```

#### Readonly mode with stored procedures

Use:

```text
config/profiles.readonly-procedures.yaml
```

or in `config/profiles.example.yaml` set:

```yaml
profiles:
  readonly:
    enabled: false
  readonly_procedures:
    enabled: true
  full:
    enabled: false
```

The `readonly_procedures` profile already includes readonly query tools plus `list_procedures`, `describe_procedure`, and `call_procedure`. Procedure execution is still limited by the YAML `procedureAllowlist`.

#### Full mode

Use:

```text
config/profiles.full.yaml
```

or in `config/profiles.example.yaml` set:

```yaml
profiles:
  readonly:
    enabled: false
  readonly_procedures:
    enabled: false
  full:
    enabled: true
```

**Note:** the `full` profile is included as a deployment/configuration stub, but Release 1 does not yet expose any full-mode tools beyond what is already implemented for readonly/readonly_procedures.

## Linux container deployment

The repo now includes a deployment script that installs prerequisites, downloads the source, builds the app, writes a systemd unit, and starts the service.

### What the deployment script installs

- `ca-certificates`
- `curl`
- `git`
- `build-essential`
- `python3`
- `gpg`
- Node.js 20 from NodeSource

### What the deployment script creates

- Source checkout: `/opt/db2-luw-mcp-server`
- Runtime env file: `/etc/db2-luw-mcp-server.env`
- systemd unit: `/etc/systemd/system/db2-luw-mcp-server.service`
- system user: `db2mcp`

### Quick deploy on Debian / Ubuntu

Run this as `root` inside the container or VM:

```bash
curl -fsSL https://raw.githubusercontent.com/gord888/db2-luw-mcp-server/main/scripts/deploy-linux-mcp.sh -o /tmp/deploy-linux-mcp.sh
chmod +x /tmp/deploy-linux-mcp.sh
/tmp/deploy-linux-mcp.sh
```

### Deploy a different mode

Readonly with procedures:

```bash
CONFIG_TEMPLATE=profiles.readonly-procedures.yaml /tmp/deploy-linux-mcp.sh
```

Full profile stub:

```bash
CONFIG_TEMPLATE=profiles.full.yaml /tmp/deploy-linux-mcp.sh
```

Deploy from a different repo/ref:

```bash
REPO_URL=https://github.com/gord888/db2-luw-mcp-server.git \
REPO_REF=main \
CONFIG_TEMPLATE=profiles.readonly.yaml \
/tmp/deploy-linux-mcp.sh
```

### Manual post-deploy configuration

1. Edit the runtime env file:

```bash
nano /etc/db2-luw-mcp-server.env
```

2. Replace the placeholder values with real API keys and DB2 connection strings.
3. If needed, edit the selected YAML file under:

```text
/opt/db2-luw-mcp-server/config
```

4. Restart the service:

```bash
systemctl restart db2-luw-mcp-server
```

5. Verify the health endpoint:

```bash
curl http://127.0.0.1:3000/healthz
```

### Recommended deployment validation

After deploying any fix or configuration change:

1. Check `/healthz`
2. Make a real MCP query call such as:

```sql
select * from tmwin.tlorder limit 1
```

## Windows local testing

### HTTP mode

```powershell
Set-Location C:\path\to\db2-luw-mcp-server
npm ci

.\scripts\start-readonly-mcp.ps1 `
  -ReadonlyApiKey "readonly-key" `
  -ReadonlyConnectionString "DATABASE=SAMPLE;HOSTNAME=db2.internal;PORT=50000;PROTOCOL=TCPIP;UID=db2_mcp_ro;PWD=secret;"
```

### stdio mode

```powershell
Set-Location C:\path\to\db2-luw-mcp-server
npm ci

.\scripts\start-readonly-stdio-mcp.ps1 `
  -ReadonlyConnectionString "DATABASE=SAMPLE;HOSTNAME=db2.internal;PORT=50000;PROTOCOL=TCPIP;UID=db2_mcp_ro;PWD=secret;"
```

### local tarball `npx`

```powershell
Set-Location C:\path\to\db2-luw-mcp-server

.\scripts\start-readonly-stdio-npx.ps1 `
  -ReadonlyConnectionString "DATABASE=SAMPLE;HOSTNAME=db2.internal;PORT=50000;PROTOCOL=TCPIP;UID=db2_mcp_ro;PWD=secret;"
```

## MCP client settings

### Direct HTTP MCP clients

Use:

- URL: `http://<host>:3000/mcp`
- Header: `Authorization: Bearer <api-key>`

If your client lets you specify headers directly, make sure it accepts Streamable HTTP traffic. This server accepts both `/mcp` and `/` for compatibility, but `/mcp` is the preferred path.

### GitHub Copilot CLI / MCP bridge using `mcp-remote`

For plain HTTP deployments:

```json
{
  "mcpServers": {
    "db2-luw-local": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://10.0.2.63:3000/mcp",
        "--allow-http",
        "--header",
        "Authorization:${DB2_LUW_AUTH}"
      ],
      "env": {
        "DB2_LUW_AUTH": "Bearer <readonly-api-key>"
      },
      "tools": [
        "*"
      ]
    }
  }
}
```

If the server is behind HTTPS, keep the same config but remove `--allow-http` and switch the URL to `https://...`.

### Local linked-command client setup

```powershell
Set-Location C:\path\to\db2-luw-mcp-server
npm ci
npm link
```

Then point your client at:

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
        "DB2_MCP_API_KEY_READONLY": "readonly-key"
      }
    }
  }
}
```

### Published package / `npx`

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
        "DB2_MCP_API_KEY_READONLY": "readonly-key"
      }
    }
  }
}
```

## Docker

The repo also includes a multi-stage `Dockerfile` that builds and runs the HTTP server on Node 20.

## Notes

- Query responses are capped at 1000 rows.
- `run_query` accepts read-only SQL only.
- `call_procedure` is available only in `readonly_procedures` profiles and requires an exact allowlist match.
- Disabled profiles no longer require their secrets to be present at startup.
