[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReadonlyConnectionString,

    [string]$ProfileId = 'readonly',

    [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'config\profiles.readonly.yaml')
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$configPathCandidate = $ConfigPath

if (-not [System.IO.Path]::IsPathRooted($configPathCandidate)) {
    $configPathCandidate = Join-Path $projectRoot $configPathCandidate
}

$resolvedConfigPath = (Resolve-Path -Path $configPathCandidate).Path

$env:DB2_MCP_CONFIG_PATH = $resolvedConfigPath
$env:DB2_MCP_DB_READONLY = $ReadonlyConnectionString

if (-not $env:DB2_MCP_API_KEY_READONLY) {
    $env:DB2_MCP_API_KEY_READONLY = 'stdio-local-readonly'
}

Push-Location $projectRoot

try {
    $packageFile = npm pack
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    $packageFile = ($packageFile | Select-Object -Last 1).Trim()
    $packagePath = Join-Path $projectRoot $packageFile

    npx --yes --package $packagePath db2-luw-mcp-server --profile=$ProfileId --config=$resolvedConfigPath
}
finally {
    Pop-Location
}
