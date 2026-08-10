param(
  [string]$CameraAddress = '192.168.1.78',
  [int]$HttpPort = 8766
)
$ErrorActionPreference = 'Stop'
$binary = Join-Path $PSScriptRoot 'build\ptzd'
if (-not (Test-Path $binary)) { throw 'Compila prima gateway/fredi-ptz/build/ptzd.' }
$settings = @{}
Get-Content 'C:\mediaflow\camera\onvif.env' | ForEach-Object {
  if ($_ -match '^([^#=]+)=(.*)$') { $settings[$matches[1]] = $matches[2].Trim('"') }
}
$apiSecret = $settings['API_TOKEN']
if (-not $apiSecret) { throw 'API_TOKEN non trovato in onvif.env.' }
$hmac = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = [Text.Encoding]::UTF8.GetBytes($apiSecret)
$ptzSecret = ([BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes('fredi-ptz-v1')))).Replace('-', '').ToLowerInvariant()
$localAddress = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.1.*' -and $_.IPAddress -ne '192.168.1.1' } | Select-Object -First 1).IPAddress
if (-not $localAddress) { throw 'Indirizzo LAN 192.168.1.x non trovato.' }
$containerName = "fredi-ptzd-installer-$PID"
$binaryDirectory = (Split-Path $binary).Replace('\', '/')
docker run --name $containerName -d --rm -p "${HttpPort}:80" -v "${binaryDirectory}:/usr/share/nginx/html:ro" nginx:1.29-alpine | Out-Null
try {
  Start-Sleep -Seconds 1
  $client = New-Object Net.Sockets.TcpClient($CameraAddress, 23)
  $stream = $client.GetStream()
  $writer = New-Object IO.StreamWriter($stream, [Text.Encoding]::ASCII)
  $writer.NewLine = "`r`n"; $writer.AutoFlush = $true
  Start-Sleep -Milliseconds 150; $writer.WriteLine('root')
  Start-Sleep -Milliseconds 250; $writer.WriteLine('')
  Start-Sleep -Milliseconds 250
  $writer.WriteLine("killall ptzd 2>/dev/null; wget -q http://${localAddress}:$HttpPort/ptzd -O /var/tmp/sd/ptzd; chmod 755 /var/tmp/sd/ptzd; /var/tmp/sd/ptzd '$ptzSecret' 23459 </dev/null >/var/tmp/sd/ptzd.log 2>&1 &")
  Start-Sleep -Seconds 2
  $writer.Dispose(); $stream.Dispose(); $client.Dispose()
  $probe = New-Object Net.Sockets.TcpClient
  $result = $probe.BeginConnect($CameraAddress, 23459, $null, $null)
  if (-not $result.AsyncWaitHandle.WaitOne(3000) -or -not $probe.Connected) { throw 'Il driver PTZ rapido non risponde sulla porta 23459.' }
  $probe.EndConnect($result); $probe.Dispose()
  Write-Host 'Driver PTZ rapido FREDI installato e raggiungibile.'
} finally {
  docker rm -f $containerName 2>$null | Out-Null
}
