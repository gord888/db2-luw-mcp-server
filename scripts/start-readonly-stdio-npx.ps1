[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConnectionString
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$env:DB2_MCP_MODE = 'readonly'
$env:DB2_MCP_API_KEY = 'stdio-local-readonly'
$env:DB2_MCP_CONNECTION_STRING = $ConnectionString

Push-Location $projectRoot

try {
    $packageFile = npm pack
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    $packageFile = ($packageFile | Select-Object -Last 1).Trim()
    $packagePath = Join-Path $projectRoot $packageFile

    npx --yes --package $packagePath db2-luw-mcp-server
}
finally {
    Pop-Location
}
