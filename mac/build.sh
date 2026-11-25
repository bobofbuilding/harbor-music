#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
address="${1:?Usage: mac/build.sh https://your-harbor/music/ /absolute/path/Harbor Music.app}"
target="${2:?Choose an app bundle path}"

[[ "$target" == /* && "$target" == *.app && ! -e "$target" && ! -L "$target" ]]
python3 - "$address" <<'PY'
import re, sys
from urllib.parse import urlsplit

try:
    url = urlsplit(sys.argv[1])
    valid = (url.scheme == 'https' and url.path == '/music/' and not url.query and not url.fragment
             and not url.username and not url.password and bool(url.hostname)
             and re.fullmatch(r'[a-zA-Z0-9.-]+', url.netloc.partition(':')[0]) and url.port != 0)
except ValueError:
    valid = False
if not valid:
    sys.exit('Provide the private HTTPS player address ending in /music/.')
PY

temp=$(mktemp -d "${TMPDIR:-/tmp}/harbor-music-build.XXXXXXXX")
cleanup() {
  case "$temp" in */harbor-music-build.*) find "$temp" -depth -delete ;; esac
}
trap cleanup EXIT
mkdir -p "$target/Contents/MacOS" "$target/Contents/Resources" "$temp/Music.iconset"
/usr/bin/swiftc -O -target "$(uname -m)-apple-macosx13.0" mac/HarborMusic.swift -o "$target/Contents/MacOS/Harbor Music"
python3 - "$address" "$target/Contents/Info.plist" <<'PY'
import plistlib, sys
from urllib.parse import urlsplit

with open(sys.argv[2], 'wb') as info:
    plistlib.dump({
        'CFBundleIdentifier': 'app.harbor-music.client',
        'CFBundleName': 'Harbor Music',
        'CFBundleDisplayName': 'Harbor Music',
        'CFBundleExecutable': 'Harbor Music',
        'CFBundleIconFile': 'HarborMusic.icns',
        'CFBundlePackageType': 'APPL',
        'CFBundleShortVersionString': '1.0.0',
        'CFBundleVersion': '1',
        'LSMinimumSystemVersion': '13.0',
        'NSHighResolutionCapable': True,
        'HarborMusicURL': sys.argv[1],
        'WKAppBoundDomains': [urlsplit(sys.argv[1]).hostname],
    }, info)
PY
for size in 16 32 128 256 512; do
  /usr/bin/sips -Z "$size" harbor_music/static/music/icon.png --out "$temp/Music.iconset/icon_${size}x${size}.png" >/dev/null
  /usr/bin/sips -Z "$((size * 2))" harbor_music/static/music/icon.png --out "$temp/Music.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$temp/Music.iconset" -o "$target/Contents/Resources/HarborMusic.icns"
/usr/bin/codesign --force --sign - "$target"
/usr/bin/codesign --verify --strict "$target"
