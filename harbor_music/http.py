"""Loopback HTTP listeners for the player and local owner controls."""

import json
import mimetypes
import os
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


STATIC_DIR = Path(__file__).parent / "static"
PAGE_POLICY = (
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
    "connect-src 'self' https:; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; "
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)


class MusicHandler(BaseHTTPRequestHandler):
    server_version = "HarborMusic"
    sys_version = ""

    def setup(self):
        self.request.settimeout(30)
        super().setup()

    def log_message(self, *_args):
        pass

    def route(self):
        host = self.headers.get("Host", "").lower()
        origin = self.headers.get("Origin")
        if self.server.owner and host not in {f"127.0.0.1:{self.server.server_port}",
                                             f"localhost:{self.server.server_port}"}:
            self.send_error_json(403, "Open the owner controls on the media host.")
            return
        opens_player = (not self.server.owner and self.command == "GET" and self.path == "/music/" and not origin
                        and self.headers.get("Sec-Fetch-Mode") == "navigate"
                        and self.headers.get("Sec-Fetch-Dest") == "document")
        if not host or (origin and origin not in (f"http://{host}", f"https://{host}")) or (
                self.headers.get("Sec-Fetch-Site") == "cross-site" and not opens_player):
            self.send_error_json(403, "Open Harbor directly.")
            return
        try:
            self.server.access.handle(self)
        except sqlite3.Error:
            self.send_error_json(503, "Harbor’s catalog is temporarily unavailable.")

    do_GET = route
    do_HEAD = route
    do_POST = route

    def send_response(self, code, message=None):
        super().send_response(code, message)
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")

    def send_json(self, value, status=200, extra_headers=None):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_error_json(self, status, message):
        self.send_json({"error": str(message)}, status)

    def read_json(self):
        return json.loads(self.rfile.read(int(self.headers["Content-Length"])))

    def serve_static(self, url):
        # Only filenames in the music API's explicit allowlist reach this method.
        path = STATIC_DIR / url.lstrip("/")
        data = path.read_bytes()
        mime = "application/manifest+json" if path.suffix == ".webmanifest" else mimetypes.guess_type(path)[0]
        self.send_response(200)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        if path.suffix == ".html":
            self.send_header("Content-Security-Policy", PAGE_POLICY)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def serve_audio(self, row):
        library = self.server.access.library
        if not library.storage_available():
            self.send_error_json(503, "The music folder is unavailable.")
            return
        try:
            path = Path(row["path"]).resolve(strict=True)
            if not path.is_relative_to(library.root) or not path.is_file():
                raise FileNotFoundError
            handle = path.open("rb")
        except (OSError, RuntimeError):
            self.send_error_json(404, "Music file unavailable.")
            return
        with handle:
            self.stream_audio(handle, path)

    def stream_audio(self, handle, path):
        size = os.fstat(handle.fileno()).st_size
        start, end = 0, size - 1
        requested = self.headers.get("Range")
        if requested is not None:
            match = re.fullmatch(r"bytes=(\d{0,20})-(\d{0,20})", requested)
            if match and any(match.groups()):
                first, last = match.groups()
                if first:
                    start = int(first)
                    if last:
                        end = min(end, int(last))
                else:
                    start = max(0, size - int(last))
            if not match or not any(match.groups()) or start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
        remaining = end - start + 1
        self.send_response(206 if requested is not None else 200)
        self.send_header("Content-Type", mimetypes.guess_type(path)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(remaining))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "private, no-store")
        if requested is not None:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command != "HEAD":
            try:
                handle.seek(start)
                while remaining and (chunk := handle.read(min(1024 * 1024, remaining))):
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except OSError:
                pass


class MusicServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, access, *, owner=False):
        self.access = access
        self.owner = owner
        super().__init__(("127.0.0.1", port), MusicHandler)
