[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReadonlyConnectionString,

    [ValidateSet('dev', 'start')]
    [string]$Mode = 'dev',

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
    if ($Mode -eq 'start') {
        node .\dist\stdio.js --profile=$ProfileId --config=$resolvedConfigPath
    }
    else {
        npm run dev:stdio -- --profile=$ProfileId --config=$resolvedConfigPath
    }
}
finally {
    Pop-Location
}
