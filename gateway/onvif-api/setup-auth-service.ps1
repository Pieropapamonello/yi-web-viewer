param(
    [string]$EnvFile = 'C:\mediaflow\camera\onvif.env'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $EnvFile)) {
    throw "File di configurazione non trovato: $EnvFile"
}

function New-RandomHex([int]$Length) {
    $bytes = New-Object byte[] $Length
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

function Read-EnvValue([string]$Content, [string]$Name) {
    $match = [regex]::Match($Content, "(?m)^$([regex]::Escape($Name))=(.*)$")
    if ($match.Success) { return $match.Groups[1].Value.Trim() }
    return ''
}

function Set-EnvValue([string]$Content, [string]$Name, [string]$Value) {
    $pattern = "(?m)^$([regex]::Escape($Name))=.*$"
    $line = "$Name=$Value"
    if ([regex]::IsMatch($Content, $pattern)) { return [regex]::Replace($Content, $pattern, $line) }
    return $Content.TrimEnd() + "`r`n" + $line + "`r`n"
}

$content = [System.IO.File]::ReadAllText($EnvFile)
$authSecret = Read-EnvValue $content 'AUTH_SECRET'
$vaultKey = Read-EnvValue $content 'VAULT_KEY'
if ($authSecret.Length -lt 32) { $authSecret = New-RandomHex 32 }
if ($vaultKey -notmatch '^[a-fA-F0-9]{64}$') { $vaultKey = New-RandomHex 32 }

$values = [ordered]@{
    AUTH_SECRET = $authSecret
    VAULT_KEY = $vaultKey.ToLowerInvariant()
    ACCOUNTS_FILE = '/data/accounts.json'
    DASHBOARD_PASSWORD_ITERATIONS = '310000'
    SESSION_DAYS = '30'
    MAX_USERS = '500'
}

foreach ($entry in $values.GetEnumerator()) {
    $content = Set-EnvValue $content $entry.Key $entry.Value
}

[System.IO.File]::WriteAllText($EnvFile, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host 'Chiavi del servizio account configurate. Registrazione pubblica pronta.' -ForegroundColor Green
Write-Host 'Le chiavi restano nel file locale escluso da Git.' -ForegroundColor Green
