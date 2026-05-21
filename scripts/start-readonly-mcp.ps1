[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReadonlyApiKey,

    [Parameter(Mandatory = $true)]
    [string]$ReadonlyConnectionString,

    [ValidateSet('dev', 'start')]
    [string]$Mode = 'dev',

    [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'config\profiles.readonly.yaml')
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$configPathCandidate = $ConfigPath

if (-not [System.IO.Path]::IsPathRooted($configPathCandidate)) {
    $configPathCandidate = Join-Path $projectRoot $configPathCandidate
}

$resolvedConfigPath = (Resolve-Path -Path $configPathCandidate).Path

$env:DB2_MCP_CONFIG_PATH = $resolvedConfigPath
$env:DB2_MCP_API_KEY_READONLY = $ReadonlyApiKey
$env:DB2_MCP_DB_READONLY = $ReadonlyConnectionString

Push-Location $projectRoot

try {
    if ($Mode -eq 'start') {
        npm start
    }
    else {
        npm run dev
    }
}
finally {
    Pop-Location
}
