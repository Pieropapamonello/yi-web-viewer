param([string]$CameraAddress = '192.168.1.78', [int]$HttpPort = 8765)
$ErrorActionPreference = 'Stop'
$build = Join-Path $PSScriptRoot 'build'
foreach ($name in @('stream-recorder','sdserver')) { if (-not (Test-Path (Join-Path $build $name))) { throw "Binary mancante: $name" } }
$settings = @{}
Get-Content 'C:\mediaflow\camera\onvif.env' | ForEach-Object { if ($_ -match '^([^#=]+)=(.*)$') { $settings[$matches[1]] = $matches[2].Trim('"') } }
$hmac = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = [Text.Encoding]::UTF8.GetBytes($settings['API_TOKEN'])
$sdSecret = ([BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes('fredi-sd-v1')))).Replace('-', '').ToLowerInvariant()
$localAddress = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.1.*' -and $_.IPAddress -ne '192.168.1.1' } | Select-Object -First 1).IPAddress
if (-not $localAddress) { throw 'Indirizzo LAN non trovato.' }
$python = Start-Process python -ArgumentList @('-m','http.server',"$HttpPort",'--bind','0.0.0.0') -WorkingDirectory $build -WindowStyle Hidden -PassThru
try {
  Start-Sleep -Seconds 1
  $client = New-Object Net.Sockets.TcpClient($CameraAddress, 23); $stream = $client.GetStream()
  $writer = New-Object IO.StreamWriter($stream, [Text.Encoding]::ASCII); $writer.NewLine = "`r`n"; $writer.AutoFlush = $true
  Start-Sleep -Milliseconds 150; $writer.WriteLine('root'); Start-Sleep -Milliseconds 250; $writer.WriteLine(''); Start-Sleep -Milliseconds 250
  $command = "cd /var/tmp/sd; test -f stream.original || cp stream stream.original; wget -q http://${localAddress}:$HttpPort/stream-recorder -O stream.new; wget -q http://${localAddress}:$HttpPort/sdserver -O sdserver.new; chmod 755 stream.new sdserver.new; mkdir -p recordings; killall -9 sdserver 2>/dev/null; mv sdserver.new sdserver; ./sdserver '$sdSecret' 23458 </dev/null >sdserver.log 2>&1 & sleep 1"
  $writer.WriteLine($command); Start-Sleep -Seconds 4; $writer.Dispose(); $stream.Dispose(); $client.Dispose()
  $headers = @{ Authorization = "Bearer $sdSecret" }
  $health = Invoke-RestMethod "http://${CameraAddress}:23458/health" -Headers $headers -TimeoutSec 5
  if (-not $health.ok) { throw 'SD server non verificato.' }
  Write-Host 'Recorder copiato; fermo il vecchio grabber e attivo quello nuovo.'
  $client = New-Object Net.Sockets.TcpClient($CameraAddress, 23); $stream = $client.GetStream(); $writer = New-Object IO.StreamWriter($stream, [Text.Encoding]::ASCII); $writer.NewLine = "`r`n"; $writer.AutoFlush = $true
  Start-Sleep -Milliseconds 150; $writer.WriteLine('root'); Start-Sleep -Milliseconds 250; $writer.WriteLine(''); Start-Sleep -Milliseconds 250; $writer.WriteLine('cd /var/tmp/sd; killall -9 rRTSPServer 2>/dev/null; killall -9 stream 2>/dev/null; sleep 1; test -s stream.new && mv stream.new stream; chmod 755 stream; sync; reboot')
  Start-Sleep -Seconds 3
  $writer.Dispose(); $stream.Dispose(); $client.Dispose()
} finally { Stop-Process -Id $python.Id -Force -ErrorAction SilentlyContinue }
