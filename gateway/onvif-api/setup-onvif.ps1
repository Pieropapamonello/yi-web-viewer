$ErrorActionPreference = 'Stop'

$cameraCredential = Get-Credential -UserName 'admin' -Message 'Credenziali ONVIF della IPC365'
$plainPassword = $cameraCredential.GetNetworkCredential().Password
$tokenBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
$apiToken = [Convert]::ToHexString($tokenBytes).ToLowerInvariant()
$target = Join-Path $PSScriptRoot 'onvif.env'

$content = @"
ONVIF_HOST=192.168.1.50
ONVIF_PORT=8080
ONVIF_USERNAME=$($cameraCredential.UserName)
ONVIF_PASSWORD=$plainPassword
API_TOKEN=$apiToken
ALLOWED_ORIGIN=https://yi-web-viewer.onrender.com
PTZ_SPEED=0.45
PTZ_DURATION_MS=350
"@

[System.IO.File]::WriteAllText($target, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host "Configurazione salvata localmente in $target" -ForegroundColor Green
Write-Host 'Token API da inserire nella dashboard (non condividerlo):' -ForegroundColor Yellow
Write-Host $apiToken
