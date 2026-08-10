$ErrorActionPreference = 'Stop'
$sourceMount = ($PSScriptRoot -replace '\\','/') + ':/src'
$command = @'
source /toolchains/sdk/activate
cd /src
mkdir -p build
mips-linux-gcc -std=gnu99 -Os -s -Wall -Ivendor/tinyalsa/include \
  -o build/talkd talkd.c \
  vendor/tinyalsa/src/pcm.c vendor/tinyalsa/src/pcm_hw.c \
  vendor/tinyalsa/src/mixer.c vendor/tinyalsa/src/mixer_hw.c \
  vendor/tinyalsa/src/limits.c vendor/tinyalsa/src/snd_card_plugin.c \
  -ldl -lpthread
'@
docker run --rm -v $sourceMount cjj25/rsdk-4.8.5-5281-el -lc $command
if ($LASTEXITCODE -ne 0) { throw 'Compilazione talkd fallita.' }
Write-Host 'Driver talkd compilato in gateway/fredi-audio/build/talkd.'
