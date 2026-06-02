[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ApiKey,

    [Parameter(Mandatory = $true)]
    [string]$ConnectionString,

    [ValidateSet('dev', 'start')]
    [string]$Mode = 'dev'
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$env:DB2_MCP_MODE = 'readonly'
$env:DB2_MCP_API_KEY = $ApiKey
$env:DB2_MCP_CONNECTION_STRING = $ConnectionString

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
