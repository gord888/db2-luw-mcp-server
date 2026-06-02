[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConnectionString,

    [ValidateSet('dev', 'start')]
    [string]$Mode = 'dev'
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$env:DB2_MCP_MODE = 'readonly'
$env:DB2_MCP_API_KEY = 'stdio-local-readonly'
$env:DB2_MCP_CONNECTION_STRING = $ConnectionString

Push-Location $projectRoot

try {
    if ($Mode -eq 'start') {
        node .\dist\stdio.js
    }
    else {
        npm run dev:stdio
    }
}
finally {
    Pop-Location
}
