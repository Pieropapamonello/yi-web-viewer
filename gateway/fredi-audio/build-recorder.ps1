$ErrorActionPreference = 'Stop'
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('fredi-recorder-' + [guid]::NewGuid().ToString('N'))
git -c http.sslVerify=false clone --depth 1 https://github.com/cjj25/Yi-RTS3903N-RTSPServer.git $temporary
git -C $temporary apply (Join-Path $PSScriptRoot 'stream-recording.patch')
if ($LASTEXITCODE -ne 0) { throw 'Applicazione patch recorder fallita.' }
$mount = ($temporary -replace '\\','/') + '/build:/to_build'
docker run --rm -v $mount cjj25/rsdk-4.8.5-5281-el -lc 'mkdir -p /to_build/output && cd /to_build/output && cmake .. && make clean && make'
if ($LASTEXITCODE -ne 0) { throw 'Compilazione stream recorder fallita.' }
New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot 'build') | Out-Null
Copy-Item (Join-Path $temporary 'build\to_sd\stream') (Join-Path $PSScriptRoot 'build\stream-recorder') -Force
$sourceMount = ($PSScriptRoot -replace '\\','/') + ':/src'
docker run --rm -v $sourceMount cjj25/rsdk-4.8.5-5281-el -lc 'source /toolchains/sdk/activate && mips-linux-gcc -Os -s -Wall -o /src/build/sdserver /src/sdserver.c'
if ($LASTEXITCODE -ne 0) { throw 'Compilazione SD server fallita.' }
Write-Host 'Recorder RTS3903N e SD server compilati in gateway/fredi-audio/build.'
