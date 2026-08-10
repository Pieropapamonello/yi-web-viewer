param(
  [string]$CameraAddress = '192.168.1.78',
  [int]$HttpPort = 8765,
  [int]$AudioDevice = 1
)
$ErrorActionPreference = 'Stop'
$binary = Join-Path $PSScriptRoot 'build\talkd'
if (-not (Test-Path $binary)) { throw 'Compila prima gateway/fredi-audio/build/talkd.' }
$settings = @{}
Get-Content 'C:\mediaflow\camera\onvif.env' | ForEach-Object {
  if ($_ -match '^([^#=]+)=(.*)$') { $settings[$matches[1]] = $matches[2].Trim('"') }
}
$apiSecret = $settings['API_TOKEN']
if (-not $apiSecret) { throw 'API_TOKEN non trovato in onvif.env.' }
$hmac = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = [Text.Encoding]::UTF8.GetBytes($apiSecret)
$talkSecret = ([BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes('fredi-talk-v1')))).Replace('-', '').ToLowerInvariant()
$localAddress = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.1.*' -and $_.IPAddress -ne '192.168.1.1' } | Select-Object -First 1).IPAddress
if (-not $localAddress) { throw 'Indirizzo LAN 192.168.1.x non trovato.' }
$python = Start-Process python -ArgumentList @('-m','http.server',"$HttpPort",'--bind','0.0.0.0','--directory',(Split-Path $binary)) -WindowStyle Hidden -PassThru
try {
  Start-Sleep -Seconds 1
  $client = New-Object Net.Sockets.TcpClient($CameraAddress, 23)
  $stream = $client.GetStream()
  $writer = New-Object IO.StreamWriter($stream, [Text.Encoding]::ASCII)
  $writer.NewLine = "`r`n"; $writer.AutoFlush = $true
  Start-Sleep -Milliseconds 150; $writer.WriteLine('root')
  Start-Sleep -Milliseconds 250; $writer.WriteLine('')
  Start-Sleep -Milliseconds 250
  $remote = "killall talkd 2>/dev/null; wget -q http://${localAddress}:$HttpPort/talkd -O /var/tmp/sd/talkd; chmod 755 /var/tmp/sd/talkd; /var/tmp/sd/talkd '$talkSecret' 23457 $AudioDevice </dev/null >/var/tmp/sd/talkd.log 2>&1 & sleep 1"
  $writer.WriteLine($remote)
  Start-Sleep -Seconds 3
  $writer.Dispose(); $stream.Dispose(); $client.Dispose()
  $probe = New-Object Net.Sockets.TcpClient
  $result = $probe.BeginConnect($CameraAddress, 23457, $null, $null)
  if (-not $result.AsyncWaitHandle.WaitOne(3000) -or -not $probe.Connected) { throw 'Il driver audio non risponde sulla porta 23457.' }
  $probe.EndConnect($result); $probe.Dispose()
  Write-Host 'Driver audio FREDI installato e raggiungibile.'
} finally {
  Stop-Process -Id $python.Id -Force -ErrorAction SilentlyContinue
}
