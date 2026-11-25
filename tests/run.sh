#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
runner="$PWD/tests/run.sh"
unset HARBOR_MUSIC_ORIGIN HARBOR_SHARE_ORIGIN HARBOR_SHARE_IMPORT_DIR HARBOR_SHARE_PORT
if [[ "${1:-}" == mobile && -z "${2:-}" ]]; then
  "$runner" mobile chromium
  "$runner" mobile webkit
  exit
fi
root=$(mktemp -d "${TMPDIR:-/tmp}/harbor-music-regression.XXXXXXXX")
export HARBOR_TEST_OFFLINE_MARKER="$root/unreachable"
pids=()
cleanup() {
  if (( ${#pids[@]} )); then
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
  case "$root" in */harbor-music-regression.*) find "$root" -depth -delete ;; esac
}
trap cleanup EXIT
mkdir -p "$root/library/music/Tide Trio/Night Harbor" "$root/library/music/Breakwater/Southern Charts" "$root/library/pictures"
cp harbor_music/static/music/icon.png "$root/library/pictures/Harbor Test Picture.png"
duration=6
if [[ "${1:-}" == mobile || "${1:-}" == handoff || "${1:-}" == recovery ]]; then duration=30; fi
ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=330:sample_rate=16000:duration=$duration" \
  -metadata genre=Jazz "$root/library/music/Tide Trio/Night Harbor/Harbor Test Song.wav"
ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:sample_rate=16000:duration=$duration" \
  -metadata genre=Rock "$root/library/music/Breakwater/Southern Charts/Second Test Song.wav"
if [[ "${1:-}" == mobile ]]; then
  mkdir -p "$root/library/music/Tide Trio Live/Night Harbor" "$root/library/music/Tide Trio/Night Harbor Deluxe"
  cp "$root/library/music/Tide Trio/Night Harbor/Harbor Test Song.wav" "$root/library/music/Tide Trio Live/Night Harbor/Colliding Artist Song.wav"
  cp "$root/library/music/Tide Trio/Night Harbor/Harbor Test Song.wav" "$root/library/music/Tide Trio/Night Harbor Deluxe/Deluxe Fixture Song.wav"
fi
if [[ "${1:-}" == downloads ]]; then
  for name in 'From Another Device' 'While Offline' 'Unchecked Favorite'; do
    cp "$root/library/music/Tide Trio/Night Harbor/Harbor Test Song.wav" "$root/library/music/Tide Trio/Night Harbor/$name.wav"
  done
fi
if [[ "${1:-}" == playback ]]; then
  python3 -B - "$root/library/music" <<'PYPLAYBACK'
from pathlib import Path
import sys, wave
album = Path(sys.argv[1]) / "Paging Artist" / "Paging Album"
album.mkdir(parents=True)
frames = bytes(16 * 8000 * 2)
for i in range(130):
    with wave.open(str(album / f"Paged track {i:03}.wav"), "wb") as audio:
        audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        audio.writeframes(frames)
PYPLAYBACK
fi
if [[ "${1:-}" == scroll* ]]; then
  python3 -B - "$root/library/music" <<'PYFIXTURE'
from pathlib import Path
import sys, wave
album = Path(sys.argv[1]) / "Paging Artist" / "Paging Album"
album.mkdir(parents=True)
for i in range(250):
    with wave.open(str(album / f"Paged track {i:03}.wav"), "wb") as audio:
        audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        audio.writeframes(bytes(1600))
PYFIXTURE
fi
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -keyout "$root/key.pem" -out "$root/cert.pem" >/dev/null 2>&1
if [[ "${1:-}" == recovery ]]; then
  node tests/recovery.cjs "$root"
  exit
fi
./setup-harbor "$root/library" --data-dir "$root/state" \
  --admin-port 28765 --music-port 28766 >"$root/server.log" 2>&1 &
pids+=($!)
node tests/https-relay.cjs "$root" >"$root/relay.log" 2>&1 &
pids+=($!)
ready=0
for attempt in {1..25}; do
  if ! kill -0 "${pids[@]}" 2>/dev/null; then
    /usr/bin/tail -n 10 "$root/server.log" "$root/relay.log"
    exit 1
  fi
  if curl -kfsS --noproxy '*' https://localhost:28767/music/api/session >/dev/null 2>&1; then
    ready=1
    break
  fi
  /bin/sleep .2
done
(( ready ))
case "${1:-both}" in
  mobile) node tests/mobile.cjs "$2" ;;
  playback) node tests/playback.cjs ;;
  handoff) node tests/handoff.cjs ;;
  downloads) node tests/downloads.cjs ;;
  *) node tests/music.cjs "${1:-both}" ;;
esac
