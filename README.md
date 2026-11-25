# Harbor Music

Harbor Music runs a private music library from a folder of audio files. Use an always-on Mac or Linux computer as your **media host**, or run it on a compatible NAS. Pair your phones, tablets, and computers with the same host to share Favorites, playlists, and where you left off. Keep device-only playlists and download selected lists for offline listening. Friend sharing is optional.

See the [design document and architecture diagram](DESIGN.md) for how an installation fits together.

## Start a library

For a computer-hosted setup, start with a music folder on the computer’s local disk. Keep the computer awake, connected to your network, and running Harbor when you want to stream. Use Python 3.11 or later for a new installation. Install FFmpeg with `ffprobe` on your `PATH` for tag extraction. Harbor can run on hosts without `ffprobe` using folder names and any previously indexed tags. Start it from the repository folder on your media host.

```sh
python3 -m harbor_music \
  --root "$HOME/Music" \
  --data-dir "$HOME/.local/share/harbor-music"
```

Open [the local owner player](http://127.0.0.1:18765/music/) on the media host. Harbor indexes the folder in the background and checks for changes every two minutes by default. For a large first scan, reload the Library view as more songs become available. Audio plays in its original format, so use formats your browser supports. MP3, AAC in M4A, and WAV are good starting points.

If either loopback port is already in use, choose other ports with `--admin-port` and `--music-port` and use those values in the addresses and proxy settings below.

Keep the state directory on the media host’s local disk. For music on a removable or network volume, pass `--mount-point /path/to/mount` when starting Harbor so it can detect a disconnected volume. Linux users can use the [systemd example](deploy/harbor-music.service) to start Harbor on boot. Edit its user, source path, and music path to match your host before enabling it. On a headless host that allows SSH forwarding, you can open the owner player through a localhost-bound tunnel to a trusted host account.

```sh
ssh -N -L 127.0.0.1:18765:127.0.0.1:18765 your-user@media-host
```

## Pair a phone or another computer

1. Give the paired player a **private HTTPS address**. Use Tailscale Serve or another HTTPS reverse proxy reachable only through your private network. Point it at `http://127.0.0.1:8765` and preserve the incoming `Host` header. Keep port `18765` local to the host.
2. For Tailscale, connect the host and the devices that will listen. On the host, configure `tailscale serve --bg http://127.0.0.1:8765` using your OS’s normal Tailscale CLI privileges. Use the URL Tailscale prints and append `/music/`. [Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve)
3. In the media host’s owner player, choose **Devices** to open **Connected devices** and get a one-time code. Open the same private HTTPS address on each device and use a new code for each pairing. On iPhone, add Harbor to the Home Screen from Safari before pairing if you plan to use the Home Screen app. Pair Safari separately if you use both.

In **Favorites** or **Downloads**, open **Download settings** to pick the lists that stay available on that device. Harbor adds and removes automatic downloads as those lists change. Manually saved songs and songs still needed by another selected list are retained. Browser storage limits apply. If playback is interrupted, Harbor retries and uses the saved position when it can. iOS may suspend the web app or require a tap on **Play** after a reload or interruption.

## Build the Mac app

With the Xcode Command Line Tools installed on macOS 13 or later, build the Mac app against the private address from the pairing steps. Choose a new destination bundle.

```sh
mac/build.sh 'https://media-host.example/music/' "$HOME/Applications/Harbor Music.app"
```

Open **Harbor Music** and pair it with the same server as your phone. The app has its own device-only playlists and downloads. Choose **File → Open in Browser** to use a previously paired browser on the same Mac.

## Adopt an existing music-only catalog

Use the adoption tool for a compatible Harbor Media NAS music catalog. Stop the old service and preserve its catalog and sharing identity together. Keep the same music folder and private HTTPS origin. The tool verifies that the catalog has the music-only schema and creates an independent SQLite backup before making the changes. Existing favorites, track IDs, pairings, and synced playlists carry over. A mixed photo, video, and music catalog requires a separate migration.

```sh
python3 -m harbor_music.adopt --root /srv/music --data-dir /var/lib/harbor-music \
  --backup /var/lib/harbor-music/pre-standalone.sqlite3
```

## Enable friend sharing

Each friend runs their own Harbor. Enable sharing only on installations that need it. Use OpenSSL with P-256 support and a dedicated writable import directory inside the music folder. Keep the rest of the music library read-only to the service where practical.

| Environment variable | Value |
| --- | --- |
| `HARBOR_MUSIC_ORIGIN` | Your private HTTPS origin, with no path. |
| `HARBOR_SHARE_IMPORT_DIR` | Absolute path to the existing import directory inside the music folder. |
| `HARBOR_SHARE_ORIGIN` | Optional dedicated HTTPS origin for outbound invites and shares. Leave unset to receive only. |
| `HARBOR_SHARE_PORT` | Transfer loopback port. The default is `8766`. |

Restart Harbor with these variables in its service environment. A sender who wants to reach a friend on another private network can expose the transfer listener through Tailscale Funnel or a dedicated HTTPS reverse proxy that preserves `Host`. Set the transfer origin to the exact exposed HTTPS address, including its port when needed. For example, on a host that supports Funnel, `tailscale funnel --bg --https=8443 http://127.0.0.1:8766` exposes the transfer listener. Use a separate HTTPS port or hostname from the private player. Verify `/invite` opens at the transfer address and `/music/api/session` there returns `404`. [Tailscale Funnel documentation](https://tailscale.com/docs/reference/tailscale-cli/funnel)

In the paired player, choose **Sharing → Create invite**. Send the link to your friend. They open it in their own Harbor and tell you the confirmation phrase. Compare it before approving. Then use **Share song** or **Share playlist** from an item’s three-dot menu. A share is bound to the approved Harbor installation, expires after three days, and closes after one verified import. A transfer can resume from the same link before it expires. Share files you have permission to distribute.

## Development

The setup examples use placeholder addresses. A built Mac app contains the private address used at build time, so keep configured app bundles, environment files, and runtime state out of a public repository.

Run the server from source with the same command as above. Browser regression tests generate synthetic audio and run against temporary libraries. They use Node.js 22 or later, Playwright with Chromium and WebKit, Bash, curl, OpenSSL, and FFmpeg. Run the suites sequentially because the player tests share local test ports.

```sh
npm install --no-save --no-package-lock playwright
npx playwright install chromium webkit
python3 -m unittest discover -s tests
./tests/run.sh
./tests/run.sh scroll
./tests/run.sh mobile
./tests/run.sh downloads
./tests/run.sh handoff
./tests/run.sh recovery
./tests/run.sh playback
node tests/sharing.cjs
```

To use an existing Playwright installation, set `HARBOR_PLAYWRIGHT` to its absolute package directory. Linux systems may need additional browser libraries for the tests. The server itself needs no browser tooling. [Playwright installation documentation](https://playwright.dev/docs/intro)
