#!/bin/sh

set -u

IPC365_RTSP_URL=${IPC365_RTSP_URL:-rtsp://192.168.1.50:554/cam/realmonitor?channel=1&subtype=0}
FREDI_G1_RTSP_URL=${FREDI_G1_RTSP_URL:-rtsp://192.168.1.78/ch0_0.h264}
MEDIAMTX_CONFIG=${MEDIAMTX_CONFIG:-/etc/mediamtx.yml}
RECONNECT_DELAY=${RECONNECT_DELAY:-1}
ARCHIVE_RETENTION_DAYS=${ARCHIVE_RETENTION_DAYS:-7}
FONT_FILE=${FONT_FILE:-/usr/share/fonts/TTF/DejaVuSansMono-Bold.ttf}

pids=''

remember_pid() {
  pids="$pids $1"
}

stop_all() {
  trap - TERM INT EXIT
  for pid in $pids; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}

run_ffmpeg() {
  name=$1
  shift
  while true; do
    ffmpeg "$@"
    code=$?
    echo "[$name] FFmpeg terminato con codice $code; riconnessione tra ${RECONNECT_DELAY}s." >&2
    sleep "$RECONNECT_DELAY"
  done
}

run_ipc365_main() {
  while true; do
    # This camera periodically closes RTSP and resets its timestamps. Publish a
    # fresh RTSP session on every reconnect so MediaMTX also resets HLS/WebRTC;
    # a long-lived UDP/MPEG-TS source turns the clock jump into a multi-minute
    # HLS segment that browsers cannot play.
    ffmpeg \
      -hide_banner -loglevel warning -fflags +genpts+discardcorrupt+igndts \
      -rtsp_transport tcp -timeout 10000000 -i "$IPC365_RTSP_URL" \
      -map 0:v:0 -map '0:a:0?' \
      -vf 'fps=20,setpts=N/(20*TB)' \
      -c:v libx264 -preset veryfast -tune zerolatency -crf 22 -g 40 -sc_threshold 0 \
      -c:a aac -b:a 48k -ar 8000 -ac 1 -af 'aresample=async=1000:first_pts=0' \
      -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/ipc365
    code=$?
    echo "[ipc365-main] FFmpeg terminato con codice $code; riconnessione tra ${RECONNECT_DELAY}s." >&2
    sleep "$RECONNECT_DELAY"
  done
}

retain_archive() {
  while true; do
    find /archive -type f \( -name '*.mp4' -o -name '*.webm' \) -mtime "+$ARCHIVE_RETENTION_DAYS" -delete
    sleep 3600
  done
}

trap stop_all TERM INT EXIT

mediamtx "$MEDIAMTX_CONFIG" &
mediamtx_pid=$!
remember_pid "$mediamtx_pid"

node /app/server.js &
gateway_pid=$!
remember_pid "$gateway_pid"

retain_archive &
remember_pid "$!"

sleep 2

run_ipc365_main &
remember_pid "$!"

run_ffmpeg fredi-main \
  -hide_banner -loglevel warning -rtsp_transport tcp -timeout 10000000 \
  -i "$FREDI_G1_RTSP_URL" \
  -map 0:v:0 -an -c:v copy \
  -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/yi &
remember_pid "$!"

sleep 4

run_ffmpeg ipc365-low \
  -hide_banner -loglevel warning -rtsp_transport tcp \
  -i rtsp://127.0.0.1:8554/ipc365 \
  -map 0:v:0 -map '0:a:0?' \
  -vf "scale=-2:480,drawtext=fontfile=${FONT_FILE}:text=%{localtime}:fontcolor=white:fontsize=22:box=1:boxcolor=black@0.70:boxborderw=8:x=12:y=h-th-12" \
  -c:v libx264 -preset veryfast -tune zerolatency -b:v 700k -maxrate 850k -bufsize 1400k -g 25 -sc_threshold 0 \
  -c:a copy -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/ipc365-low &
remember_pid "$!"

run_ffmpeg ipc365-webrtc \
  -hide_banner -loglevel warning -fflags nobuffer -flags low_delay -rtsp_transport tcp \
  -i rtsp://127.0.0.1:8554/ipc365 \
  -map 0:v:0 -map '0:a:0?' -c:v copy \
  -c:a libopus -application lowdelay -frame_duration 20 -b:a 32k -ar 48000 -ac 1 \
  -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/ipc365-webrtc &
remember_pid "$!"

run_ffmpeg fredi-low \
  -hide_banner -loglevel warning -rtsp_transport tcp \
  -i rtsp://127.0.0.1:8554/yi \
  -map 0:v:0 \
  -vf "scale=-2:480,drawtext=fontfile=${FONT_FILE}:text=%{localtime}:fontcolor=white:fontsize=22:box=1:boxcolor=black@0.70:boxborderw=8:x=12:y=h-th-12" \
  -c:v libx264 -preset veryfast -tune zerolatency -b:v 700k -maxrate 850k -bufsize 1400k -g 40 -sc_threshold 0 \
  -an -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/yi-low &
remember_pid "$!"

run_ffmpeg fredi-webrtc \
  -hide_banner -loglevel warning -fflags nobuffer -flags low_delay -rtsp_transport tcp \
  -i rtsp://127.0.0.1:8554/yi \
  -map 0:v:0 -an -c:v copy \
  -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/yi-webrtc &
remember_pid "$!"

while kill -0 "$mediamtx_pid" 2>/dev/null && kill -0 "$gateway_pid" 2>/dev/null; do
  sleep 5
done

echo 'Un processo principale si è arrestato; riavvio del servizio unico.' >&2
exit 1
