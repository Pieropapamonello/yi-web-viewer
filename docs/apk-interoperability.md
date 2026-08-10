# APK interoperability notes

This document records only interfaces observed in the user-supplied application
packages. It does not include credentials, cloud tokens, APK files, decompiled
sources, or vendor binaries.

## Packages inspected

| Camera family | Application | Package | Version | SHA-256 |
| --- | --- | --- | --- | --- |
| FREDI G1 | ZKlink | `com.zkcam.iot` | `1.0.3_20251202` | `07870B787D0A59D064360F54628552C390E0AF6FBCAC643B13DBF14A31DD460C` |
| IPC360 | IPC360 Pro | `com.ipc360pro` | `3.9.5.2` | `88517C6166950337103423CB7A163B3EF3481692020C127D0527CA0DC4561ABF` |

## ZKlink / FREDI G1

ZKlink contains the Glnk P2P SDK. Its public Java/JNI surface confirms:

- main/sub stream selection;
- two-way audio and talk volume;
- remote-file search and playback;
- local video recording;
- PTZ move/stop, diagonals, preset set/go/delete and tours;
- generic zoom, focus and iris commands.

The command identifiers exported by `glnk.io.GlnkCode.PTZCMD` are generic SDK
identifiers, not `/dev/ssp` ioctl values. They cannot be sent to the RTSP socket.
The modified FREDI therefore continues to use the verified on-camera helpers:
`ptzctl`, `talkd`, the recorder and `sdserver`. Optical zoom/focus must remain
disabled unless the camera hardware and its kernel drivers expose those motors.

## IPC360 Pro

IPC360 Pro contains `libpwnativenetsdk.so` and the `com.xmcamera.core` API. The
SDK surface confirms device operations for:

- live stream and bidirectional talk;
- PTZ, panorama, presets and tours;
- camera tracking;
- camera lamp, brightness and day/night switching;
- alarm switch, sound and motion parameters;
- microphone, intercom and prompt volumes;
- TF-card state, format, continuous/event recording and storage selection;
- TF index search, timeline parsing and remote playback;
- camera zoom on models that advertise the corresponding feature.

The TF recording constants are `TF_StorageMode_LOOP = 0` and
`TF_StorageMode_EVENT = 1`. Storage modes include TF, cloud and TF+cloud.
These operations are transported by the proprietary P2P SDK, not by ONVIF or
the HLS stream. Seeing an API in the APK proves that the app family supports it;
it does not prove that a particular camera model implements it.

## Gateway status

| Function | FREDI G1 | IPC360 camera |
| --- | --- | --- |
| RTSP/HLS/WebRTC | Implemented | Implemented |
| Directional PTZ | Implemented through `/dev/ssp` | Implemented from verified LAN frames |
| Browser talk | Implemented through `talkd` on the analog speaker device | Disabled until a complete model-specific session is captured and acknowledged |
| Direct camera SD recording | Implemented | Awaiting TF protocol capture |
| Camera SD timeline/playback | Implemented | Awaiting TF protocol capture |
| Lamp/alarm/tracking device controls | Driver/API/UI ready; requires model-specific helper commands | Driver/API/UI ready; requires verified command captures |
| Zoom | Digital viewer zoom; no optical motor verified | Optical driver/API/UI ready; requires model support and capture |

Unsupported controls must remain disabled instead of reporting success without
a device acknowledgement.

## Captures required for IPC360

Record one short PCAP per action, starting from the same idle live-view screen:

1. lamp off/on/auto;
2. alarm sound off/on;
3. motion tracking off/on;
4. TF recording continuous/event/off;
5. open TF timeline, select one time and start/stop playback;
6. change microphone/intercom volume;
7. optical zoom in/out, only if the official app offers it for this camera.

Separate captures make request/response pairs and session identifiers
distinguishable. The gateway should implement a command only after its request,
stop/rollback behavior and acknowledgement have all been identified.
