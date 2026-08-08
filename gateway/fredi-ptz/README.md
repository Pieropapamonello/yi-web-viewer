# FREDI G1 PTZ helper

`ptzctl` controls the two stepper motors exposed by the camera's
`ssp_ms41909` kernel module at `/dev/ssp`. The RTSP firmware does not provide
ONVIF PTZ, so the local gateway invokes this small helper through the camera's
LAN-only Telnet service.

Every directional command has a bounded duration and ends with an explicit
stop command. The helper accepts:

```text
ptzctl <up|down|left|right|stop> [milliseconds] [timing]
```

Build the MIPS/uClibc binary from the repository root:

```powershell
docker run --rm -v "${PWD}\gateway\fredi-ptz:/src" cjj25/rsdk-4.8.5-5281-el `
  -lc '/toolchains/sdk/bin/mips-linux-uclibc-gcc -Os -s -o /src/build/ptzctl /src/ptzctl.c'
```

Install it as executable at `/var/tmp/sd/ptzctl` on the camera. Keep Telnet
and the control gateway private to the trusted LAN; only the authenticated
HTTPS gateway endpoint should be exposed to the web app.
