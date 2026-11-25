"""Start an independent Harbor Music server."""

import argparse
import fcntl
import logging
import os
import shutil
import signal
import sqlite3
import threading
from contextlib import ExitStack
from pathlib import Path

from .api import MusicAccess
from .http import MusicServer
from .library import MusicLibrary
from .sharing import configured_sharing


def serve(args):
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        logging.info("ffprobe is unavailable. Existing tags are retained and new tracks use folder names.")
    root = args.root.expanduser().resolve(strict=True)
    state = args.data_dir.expanduser().resolve()
    mount_point = args.mount_point.expanduser().resolve() if args.mount_point else None
    if mount_point and not root.is_relative_to(mount_point):
        raise ValueError("The music folder must be inside the configured mount.")
    if state.is_relative_to(root) or root.is_relative_to(state):
        raise ValueError("Use separate folders for the music library and Harbor state.")

    os.umask(0o077)
    state.mkdir(parents=True, exist_ok=True)
    stop = threading.Event()
    with ExitStack() as stack:
        lock = stack.enter_context((state / "server.lock").open("a"))
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("This Harbor state directory is already in use.") from error
        library = MusicLibrary(root, state, ffprobe, mount_point)
        sharing, gateway = configured_sharing(library)
        if gateway:
            stack.enter_context(gateway)
        access = MusicAccess(library, sharing)
        player = stack.enter_context(MusicServer(args.music_port, access))
        owner = stack.enter_context(MusicServer(args.admin_port, access, owner=True))

        signal.signal(signal.SIGINT, lambda *_: stop.set())
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        servers = [player, owner, *([gateway] if gateway else [])]
        for server in servers:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        threading.Thread(target=library.watch, args=(args.scan_interval, stop), daemon=True).start()
        logging.info("Media host controls: http://127.0.0.1:%s/music/", owner.server_port)
        logging.info("Private HTTPS proxy target: http://127.0.0.1:%s", player.server_port)
        if gateway:
            logging.info("Transfer HTTPS proxy target: http://127.0.0.1:%s", gateway.server_port)
        stop.wait()
        for server in servers:
            server.shutdown()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="folder containing your music")
    parser.add_argument("--data-dir", type=Path, required=True, help="directory for Harbor's private state")
    parser.add_argument("--mount-point", type=Path, help="required mount for a removable or network music folder")
    parser.add_argument("--scan-interval", type=int, default=120, help="seconds between scans (default: 120)")
    parser.add_argument("--music-port", type=int, default=8765, help="loopback port for the paired player")
    parser.add_argument("--admin-port", type=int, default=18765, help="loopback port for the media host controls")
    args = parser.parse_args()
    if args.scan_interval < 1:
        parser.error("--scan-interval must be at least one second")
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        serve(args)
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        parser.exit(1, f"Harbor Music: {error}\n")


if __name__ == "__main__":
    main()
