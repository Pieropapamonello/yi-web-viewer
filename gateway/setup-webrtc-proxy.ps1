$ErrorActionPreference = 'Stop'

$npmBaseUrl = 'http://127.0.0.1:81/api'
$cameraDomain = 'camera.nelloonrender.duckdns.org'
$rtcDomain = 'rtc.nelloonrender.duckdns.org'
$allowedOrigin = 'https://yi-web-viewer.onrender.com'
$credential = Get-Credential -Message 'Nginx Proxy Manager: email e password amministratore per attivare WebRTC'
$tokenResponse = Invoke-RestMethod -Uri "$npmBaseUrl/tokens" -Method Post -ContentType 'application/json' -Body (@{
    identity = $credential.UserName
    secret = $credential.GetNetworkCredential().Password
} | ConvertTo-Json)
if (-not $tokenResponse.token) { throw 'Nginx Proxy Manager non ha restituito un token.' }
$headers = @{ Authorization = "Bearer $($tokenResponse.token)" }

function Invoke-NpmRequest {
    param([string]$Step, [string]$Uri, [string]$Method, [object]$Body)
    try {
        $arguments = @{ Uri=$Uri; Headers=$headers; Method=$Method }
        if ($null -ne $Body) {
            $arguments.ContentType = 'application/json'
            $arguments.Body = $Body | ConvertTo-Json -Depth 8
        }
        Invoke-RestMethod @arguments
    } catch {
        $detail = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        throw "$Step non riuscito: $detail"
    }
}

function Get-Hosts {
    Invoke-RestMethod -Uri "$npmBaseUrl/nginx/proxy-hosts" -Headers $headers -Method Get
}

$cameraHost = Get-Hosts | Where-Object { $_.domain_names -contains $cameraDomain } | Select-Object -First 1
if (-not $cameraHost) { throw "Proxy esistente $cameraDomain non trovato." }

$cors = @'
add_header Access-Control-Allow-Origin "https://yi-web-viewer.onrender.com" always;
add_header Access-Control-Allow-Methods "OPTIONS, GET, POST, PATCH, DELETE" always;
add_header Access-Control-Allow-Headers "Authorization, Content-Type, If-Match" always;
add_header Access-Control-Expose-Headers "Location, Link, ETag" always;
add_header Access-Control-Max-Age "86400" always;
if ($request_method = OPTIONS) { return 204; }
'@

$rtcHost = Get-Hosts | Where-Object { $_.domain_names -contains $rtcDomain } | Select-Object -First 1
if (-not $rtcHost) {
    $rtcHost = Invoke-NpmRequest -Step 'Creazione proxy WebRTC' -Uri "$npmBaseUrl/nginx/proxy-hosts" -Method Post -Body @{
        domain_names = @($rtcDomain)
        forward_scheme = 'http'
        forward_host = 'camera-mediamtx'
        forward_port = 8889
        access_list_id = [int]$cameraHost.access_list_id
        advanced_config = $cors
    }
}

$certificateId = [int]$rtcHost.certificate_id
if ($certificateId -le 0) {
    $certificate = (Invoke-RestMethod -Uri "$npmBaseUrl/nginx/certificates" -Headers $headers -Method Get) |
        Where-Object { $_.domain_names -contains $rtcDomain } | Select-Object -First 1
    if (-not $certificate) {
        $certificate = Invoke-NpmRequest -Step 'Certificato WebRTC' -Uri "$npmBaseUrl/nginx/certificates" -Method Post -Body @{
            provider = 'letsencrypt'
            nice_name = $rtcDomain
            domain_names = @($rtcDomain)
            meta = @{ dns_challenge = $false }
        }
    }
    $certificateId = [int]$certificate.id
}
if ($certificateId -le 0) { throw 'Certificato WebRTC non disponibile.' }

$rtcHost = Get-Hosts | Where-Object { $_.domain_names -contains $rtcDomain } | Select-Object -First 1
Invoke-NpmRequest -Step 'Attivazione HTTPS WebRTC' -Uri "$npmBaseUrl/nginx/proxy-hosts/$($rtcHost.id)" -Method Put -Body @{
    certificate_id = $certificateId
    ssl_forced = $true
    block_exploits = $false
    http2_support = $true
    hsts_enabled = $true
    hsts_subdomains = $false
    access_list_id = [int]$cameraHost.access_list_id
    advanced_config = $cors
} | Out-Null

Start-Sleep -Seconds 3
$preflight = Invoke-WebRequest -UseBasicParsing -Method Options -Uri "https://$rtcDomain/ipc365-webrtc/whep" -Headers @{
    Origin = $allowedOrigin
    'Access-Control-Request-Method' = 'POST'
    'Access-Control-Request-Headers' = 'authorization,content-type'
} -TimeoutSec 15
if ($preflight.StatusCode -ne 204 -or $preflight.Headers['Access-Control-Allow-Origin'] -ne $allowedOrigin) {
    throw 'Preflight CORS WebRTC non valida.'
}

Write-Host "WebRTC HTTPS configurato: https://$rtcDomain/ipc365-webrtc/whep" -ForegroundColor Green
Write-Host 'Ora inoltra UDP 8189 del modem verso 192.168.1.2:8189.' -ForegroundColor Yellow
