# FREDI G1 talk helper

`talkd` receives authenticated 8 kHz mono signed 16-bit PCM from the LAN
gateway and writes it to the RTS3903N ALSA playback device. It binds only on
the camera LAN and requires a random token of at least 24 characters before
accepting audio.

The browser never connects to this port directly. Its microphone is sent over
the authenticated HTTPS camera gateway, which resamples and forwards PCM.

The helper is installed as `/var/tmp/sd/talkd`; `install.ps1` derives its
authentication secret from the existing gateway token, transfers the binary
inside the LAN, starts it, and verifies port 23457. No camera credential is
written to the repository.

Build target: MIPS32 little-endian with the RTS3903N toolchain and tinyalsa
(`pcm.c`, `pcm_hw.c`, `limits.c`, `snd_card_plugin.c`, `-ldl -lpthread`).

## Direct microSD recording

`build-recorder.ps1` applies `stream-recording.patch` to the upstream grabber
and builds both the recorder and `sdserver`. `install-recorder.ps1` keeps
`stream.original` as rollback, installs the binaries, and reboots the camera.
Recording is opt-in through `/var/tmp/sd/recording.enabled`; completed 60-second
H.264 segments and requested JPEG snapshots live in `/var/tmp/sd/recordings`,
while `.partial` files are never exposed. `/var/tmp/sd/recording.limit` contains
an optional byte limit. A value of `0` uses the whole card in circular mode,
keeps a 512 MiB safety reserve, and deletes only the oldest completed media.
The authenticated SD helper exposes capacity, timeline, configuration, media
download and deletion to the account gateway.

Rollback from Telnet, if ever needed:

```sh
cd /var/tmp/sd
killall rRTSPServer; killall stream
cp stream.original stream
sync; reboot
```
