"""Recipient-bound music sharing across independent Harbor installations."""

import base64
from contextlib import closing
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import threading
import time
from urllib.parse import quote, urlsplit

from .library import AUDIO_EXTENSIONS, track_id

TRACK = re.compile(r"[0-9a-f]{40}")
SHA256 = re.compile(r"[0-9a-f]{64}")
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
P256 = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d03010703420004")
CHUNK = 2 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
MAX_TRACKS = 128
MAX_PENDING = 4
WINDOW = 3 * 86400
OPENSSL = shutil.which("openssl")


class ShareError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def fail(message="This request is unavailable.", status=403):
    raise ShareError(message, status)


def token(value):
    if not isinstance(value, str) or not TOKEN.fullmatch(value):
        fail("Invalid Harbor link.", 404)
    return value


def origin(value):
    if not isinstance(value, str) or len(value) > 270:
        fail("Enter a valid Harbor HTTPS address.")
    try:
        url = urlsplit(value)
        port = url.port
    except ValueError:
        fail("Enter a valid Harbor HTTPS address.")
    if (url.scheme != "https" or url.path not in ("", "/") or url.query or url.fragment or
            url.username or url.password or not url.hostname or
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", url.hostname) or port == 0):
        fail("Enter a valid Harbor HTTPS address.")
    return f"https://{url.hostname}" + (f":{port}" if port and port != 443 else "")


def label(value, fallback=None):
    if isinstance(value, str):
        value = "".join(char for char in value.strip() if char.isprintable()).strip()
        if value:
            return value[:180]
    if fallback is not None:
        return fallback
    fail("Enter a name.")


def encode(data):
    return json.dumps(data, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def secret():
    return secrets.token_urlsafe(32)


def b64(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def unb64(value, lower, upper):
    if not isinstance(value, str) or len(value) > 2 * upper or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        fail()
    try:
        data = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except ValueError:
        fail()
    if not lower <= len(data) <= upper or b64(data) != value:
        fail()
    return data


def public_key(value):
    data = unb64(value, len(P256) + 64, len(P256) + 64)
    if not data.startswith(P256):
        fail()
    return value


def crypto(*args, data=None):
    return subprocess.run([OPENSSL, *args], input=data, capture_output=True, timeout=5, check=True).stdout


class Identity:
    def __init__(self, directory):
        self.path = directory / "identity.pem"
        if not self.path.exists():
            private = crypto("ecparam", "-name", "prime256v1", "-genkey", "-noout")
            with tempfile.NamedTemporaryFile(dir=directory) as key:
                key.write(private)
                key.flush()
                try:
                    os.link(key.name, self.path)
                except FileExistsError:
                    pass
        self.key = public_key(b64(crypto("pkey", "-in", str(self.path), "-pubout", "-outform", "DER")))

    def sign(self, context, payload):
        return b64(crypto("dgst", "-sha256", "-sign", str(self.path), data=encode([context, payload])))

    def verify(self, key, context, payload, signature):
        der = unb64(public_key(key), len(P256) + 64, len(P256) + 64)
        proof = unb64(signature, 8, 80)
        with tempfile.NamedTemporaryFile() as pub, tempfile.NamedTemporaryFile() as sig:
            pub.write(b"-----BEGIN PUBLIC KEY-----\n" + base64.encodebytes(der) + b"-----END PUBLIC KEY-----\n")
            sig.write(proof)
            pub.flush()
            sig.flush()
            try:
                crypto("dgst", "-sha256", "-verify", pub.name, "-signature", sig.name,
                       data=encode([context, payload]))
            except subprocess.CalledProcessError:
                fail("This Harbor has not been approved for the transfer.")


def phrase(request):
    check = digest(encode(["harbor-friend-v1", request]))[:12].upper()
    return "-".join(check[index:index + 4] for index in (0, 4, 8))


def read_json(handler, limit=262144):
    if handler.headers.get_content_type() != "application/json":
        fail("Expected a Harbor request.", 415)
    raw = read_body(handler, limit)
    try:
        value = json.loads(raw)
    except ValueError:
        fail("Invalid Harbor request.")
    if not isinstance(value, dict):
        fail("Invalid Harbor request.")
    return value


def read_body(handler, limit):
    size = handler.headers.get("Content-Length", "")
    if not re.fullmatch(r"[0-9]{1,9}", size) or not 0 < int(size) <= limit:
        fail("Invalid transfer size.", 413)
    result = handler.rfile.read(int(size))
    if len(result) != int(size):
        fail("Incomplete request.")
    return result


def file_hash(stream, size):
    result = hashlib.sha256()
    remaining = size
    while remaining:
        block = stream.read(min(remaining, 1024 * 1024))
        if not block:
            fail("The selected file changed.", 409)
        result.update(block)
        remaining -= len(block)
    if stream.read(1):
        fail("The selected file changed.", 409)
    return result.hexdigest()


def fingerprint(info):
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]


def audio_header(stream, extension):
    head = stream.read(24)
    stream.seek(0)
    if extension in (".mp3", ".aac"):
        return head.startswith(b"ID3") or len(head) >= 2 and head[0] == 255 and head[1] >= 224
    if extension in (".m4a", ".alac"):
        return head[4:8] in (b"ftyp", b"moov", b"mdat", b"free", b"wide")
    if extension in (".ogg", ".oga", ".opus"):
        return head.startswith(b"OggS")
    if extension == ".flac":
        return head.startswith((b"fLaC", b"ID3"))
    if extension == ".wav":
        return head[:4] in (b"RIFF", b"RF64", b"BW64") and head[8:12] == b"WAVE"
    if extension in (".aiff", ".aif"):
        return head.startswith(b"FORM") and head[8:12] in (b"AIFF", b"AIFC")
    return extension == ".wma" and head.startswith(bytes.fromhex("3026b2758e66cf11a6d900aa0062ce6c"))


class Sharing:
    def __init__(self, library, gateway, music_origin, imports):
        self.library = library
        self.gateway = origin(gateway) if gateway else None
        self.music_origin = origin(music_origin)
        if self.gateway == self.music_origin:
            fail("Sharing needs its own HTTPS address.")
        if not imports.is_dir() or imports.is_symlink() or not imports.resolve().is_relative_to(library.root):
            fail("Configure a dedicated import folder in the music library.")
        self.imports = imports.resolve()
        self.work = self.imports / ".harbor-incoming"
        self.work.mkdir(mode=0o700, exist_ok=True)
        if self.work.is_symlink() or not self.work.is_dir():
            fail("The transfer staging folder is unavailable.")
        storage = library.db_path.parent / "harbor-sharing"
        storage.mkdir(mode=0o700, exist_ok=True)
        self.identity = Identity(storage)
        self.lock = threading.RLock()
        with closing(library.connect()) as db, db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS share_friends (
                    key TEXT PRIMARY KEY, name TEXT NOT NULL, gateway TEXT, music TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS share_invites (
                    token TEXT PRIMARY KEY, name TEXT NOT NULL, expires INTEGER NOT NULL,
                    request TEXT, approved INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS share_requests (
                    token TEXT PRIMARY KEY, name TEXT NOT NULL, details TEXT NOT NULL, expires INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS share_offers (
                    token TEXT PRIMARY KEY, recipient TEXT NOT NULL, expires INTEGER NOT NULL,
                    challenge TEXT NOT NULL, manifest TEXT NOT NULL, files TEXT NOT NULL, lease TEXT,
                    consumed INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS share_imports (
                    id TEXT PRIMARY KEY, manifest TEXT NOT NULL, receipt TEXT
                );
                CREATE INDEX IF NOT EXISTS share_audio_size ON media(size) WHERE kind='audio';
            """)

    def private(self, handler, endpoint):
        functions = {
            "invite": self.invite, "request": self.request, "approve": self.approve,
            "confirm": self.confirm, "revoke": self.revoke, "share": self.share,
            "proof": self.proof, "preview": self.preview, "begin": self.begin, "complete": self.complete,
        }
        try:
            if endpoint == "friends" and handler.command == "GET":
                handler.send_json(self.friends())
            elif endpoint == "part" and handler.command == "POST":
                data = read_body(handler, CHUNK)
                handler.send_json(self.part(handler.headers, data))
            elif handler.command == "POST" and endpoint in functions:
                handler.send_json(functions[endpoint](read_json(handler)))
            else:
                handler.send_error_json(404, "Harbor command unavailable.")
        except ShareError as error:
            handler.send_error_json(error.status, error)
        except (OSError, sqlite3.Error, subprocess.SubprocessError, ValueError):
            handler.send_error_json(503, "Harbor couldn’t finish the sharing request.")

    def friends(self):
        with closing(self.library.connect()) as db:
            return {
                "key": self.identity.key,
                "friends": [dict(row) for row in db.execute("SELECT * FROM share_friends ORDER BY name COLLATE NOCASE")],
                "invites": [{"token": row["token"], "name": row["name"], "phrase":
                             phrase(json.loads(row["request"])) if row["request"] else None}
                            for row in db.execute("SELECT * FROM share_invites WHERE approved=0 AND expires>?",
                                                  (int(time.time()),))],
                "requests": [{"token": row["token"], "name": row["name"], "details": json.loads(row["details"])}
                             for row in db.execute("SELECT * FROM share_requests WHERE expires>?", (int(time.time()),))],
            }

    def invite(self, data):
        if not self.gateway:
            fail("Configure a transfer address to send invites.", 403)
        value = secret()
        with closing(self.library.connect()) as db, db:
            db.execute("INSERT INTO share_invites (token,name,expires) VALUES (?,?,?)",
                       (value, label(data.get("name")), int(time.time()) + WINDOW))
        return {"link": self.gateway + "/invite#" + value}

    def invite_row(self, db, value):
        row = db.execute("SELECT * FROM share_invites WHERE token=? AND expires>?",
                         (token(value), int(time.time()))).fetchone()
        if not row:
            fail("This invitation has expired.", 404)
        return row

    def invite_info(self, data, client):
        with closing(self.library.connect()) as db:
            row = self.invite_row(db, data.get("token"))
        return {"key": self.identity.key, "expires": row["expires"]}

    def request(self, data):
        value = token(data.get("token"))
        details = {"token": value, "sender": public_key(data.get("sender")), "gateway": origin(data.get("gateway")),
                   "recipient": self.identity.key, "recipient_gateway": self.gateway, "music": self.music_origin}
        if details["sender"] == self.identity.key or details["gateway"] == self.gateway:
            fail("Open the invitation in the other Harbor library.")
        name = label(data.get("name"))
        with closing(self.library.connect()) as db, db:
            db.execute("INSERT OR REPLACE INTO share_requests VALUES (?,?,?,?)",
                       (value, name, encode(details).decode(), int(time.time()) + WINDOW))
        return {"details": details, "signature": self.identity.sign("friend-request", details), "phrase": phrase(details)}

    def invite_request(self, data, client):
        value = data.get("details")
        if not isinstance(value, dict):
            fail()
        recipient_gateway = value.get("recipient_gateway")
        details = {"token": token(value.get("token")), "sender": self.identity.key, "gateway": self.gateway,
                   "recipient": public_key(value.get("recipient")),
                   "recipient_gateway": origin(recipient_gateway) if recipient_gateway is not None else None,
                   "music": origin(value.get("music"))}
        if details != value or client != details["music"] or details["recipient"] == self.identity.key:
            fail()
        self.identity.verify(details["recipient"], "friend-request", details, data.get("signature"))
        serialized = encode(details).decode()
        with closing(self.library.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = self.invite_row(db, details["token"])
            if row["request"] and row["request"] != serialized:
                fail("This invitation already has an approval request.", 409)
            if not row["request"]:
                db.execute("UPDATE share_invites SET request=? WHERE token=?", (serialized, details["token"]))
        return {"phrase": phrase(details)}

    @staticmethod
    def store_friend(db, key, name, gateway, music):
        db.execute("INSERT INTO share_friends VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET "
                   "name=excluded.name, gateway=excluded.gateway, music=excluded.music", (key, name, gateway, music))

    def approve(self, data):
        with closing(self.library.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = self.invite_row(db, data.get("token"))
            if row["approved"] or not row["request"]:
                fail("This friend request is unavailable.", 409)
            details = json.loads(row["request"])
            if data.get("phrase") != phrase(details):
                fail("Check the pairing phrase before approving.")
            self.store_friend(db, details["recipient"], row["name"], details["recipient_gateway"], details["music"])
            db.execute("UPDATE share_invites SET approved=1 WHERE token=?", (details["token"],))
        return {"approved": True}

    def confirmation(self, data, client):
        with closing(self.library.connect()) as db:
            row = self.invite_row(db, data.get("token"))
            details = json.loads(row["request"]) if row["request"] else None
            if not details or client != details["music"]:
                fail()
            self.identity.verify(details["recipient"], "friend-confirm", details, data.get("signature"))
            if not row["approved"]:
                return {"approved": False}
            if not db.execute("SELECT 1 FROM share_friends WHERE key=?", (details["recipient"],)).fetchone():
                fail("This friend was removed.", 404)
        approved = {"details": details, "music": self.music_origin}
        return {"approved": True, "confirmation": approved, "signature": self.identity.sign("friend-approved", approved)}

    def confirm(self, data):
        value = token(data.get("token"))
        with closing(self.library.connect()) as db, db:
            row = db.execute("SELECT * FROM share_requests WHERE token=? AND expires>?",
                             (value, int(time.time()))).fetchone()
            if not row:
                fail("This invitation has expired.", 404)
            details = json.loads(row["details"])
            if "confirmation" not in data:
                return {"signature": self.identity.sign("friend-confirm", details)}
            approved = data["confirmation"]
            if not isinstance(approved, dict) or approved.get("details") != details:
                fail()
            self.identity.verify(details["sender"], "friend-approved", approved, data.get("signature"))
            self.store_friend(db, details["sender"], row["name"], details["gateway"], origin(approved.get("music")))
            db.execute("DELETE FROM share_requests WHERE token=?", (value,))
        return {"approved": True}

    def revoke(self, data):
        peer = public_key(data.get("key"))
        with closing(self.library.connect()) as db, db:
            db.execute("DELETE FROM share_friends WHERE key=?", (peer,))
            db.execute("DELETE FROM share_offers WHERE recipient=? AND consumed=0", (peer,))
        return {"removed": True}

    def media_path(self, value):
        if not self.library.storage_available():
            fail("The music folder is unavailable.", 503)
        path = Path(value).resolve(strict=True)
        if not path.is_relative_to(self.library.root) or not path.is_file() or path.suffix.lower() not in AUDIO_EXTENSIONS:
            fail("A selected audio file is unavailable.", 409)
        return path

    def snapshot(self, ids):
        if (not isinstance(ids, list) or not 0 < len(ids) <= MAX_TRACKS or
                any(not isinstance(value, str) or not TRACK.fullmatch(value) for value in ids) or len(set(ids)) != len(ids)):
            fail(f"Share between 1 and {MAX_TRACKS} distinct songs.")
        songs, files, total = [], [], 0
        for identifier in ids:
            row = self.library.get_row(identifier)
            if not row or row["kind"] != "audio":
                fail("A selected song is unavailable.", 409)
            path = self.media_path(row["path"])
            with path.open("rb") as stream:
                info = os.fstat(stream.fileno())
                total += info.st_size
                if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_FILE or total > MAX_TOTAL:
                    fail("Shares support up to 64 MiB per song and 512 MiB total.", 413)
                if not audio_header(stream, path.suffix.lower()):
                    fail("Harbor couldn’t recognize the selected audio file.", 415)
                checksum = file_hash(stream, info.st_size)
                if fingerprint(info) != fingerprint(os.fstat(stream.fileno())):
                    fail("A selected file changed. Create the share again.", 409)
            songs.append({"title": label(row["title"], "Shared song"), "artist": label(row["artist"], ""),
                          "album": label(row["album"], ""), "size": info.st_size, "extension": path.suffix.lower(),
                          "sha256": checksum})
            files.append({"path": str(path), "stat": fingerprint(info)})
        return songs, files

    def share(self, data):
        if not self.gateway:
            fail("Configure a transfer address to send music.", 403)
        peer = public_key(data.get("key"))
        with closing(self.library.connect()) as db:
            friend = db.execute("SELECT * FROM share_friends WHERE key=?", (peer,)).fetchone()
        if not friend:
            fail("Pick an approved friend.")
        kind = data.get("kind")
        if kind not in ("song", "playlist"):
            fail("Choose a song or playlist.")
        name = label(data.get("name"), "Shared playlist")
        songs, files = self.snapshot(data.get("tracks"))
        if kind == "song" and len(songs) != 1:
            fail("Choose one song.")
        value, deadline = secret(), int(time.time()) + WINDOW
        manifest = {"token": value, "kind": kind, "name": name if kind == "playlist" else songs[0]["title"],
                    "sender": self.identity.key, "recipient": peer, "gateway": self.gateway,
                    "expires": deadline, "songs": songs}
        with closing(self.library.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM share_friends WHERE key=?", (peer,)).fetchone():
                fail("This friend was removed.", 409)
            db.execute("INSERT INTO share_offers VALUES (?,?,?,?,?,?,NULL,0)",
                       (value, peer, deadline, secret(), encode(manifest).decode(), encode(files).decode()))
        transfer = self.gateway + "/transfer#" + value
        return {"link": friend["music"] + "/music/#share=" + quote(transfer, safe=""),
                "expires": deadline}

    def offer(self, db, value, client):
        row = db.execute("SELECT offer.* FROM share_offers AS offer JOIN share_friends AS friend "
                         "ON friend.key=offer.recipient WHERE token=? AND expires>? AND friend.music=?",
                         (token(value), int(time.time()), client)).fetchone()
        if not row:
            fail("This share is unavailable or has expired.", 404)
        return row

    def challenge(self, data, client):
        with closing(self.library.connect()) as db:
            row = self.offer(db, data.get("token"), client)
            if data.get("key") != row["recipient"]:
                fail("This share belongs to another Harbor.")
            return {"sender": self.identity.key, "challenge": row["challenge"], "issued": int(time.time()) // 60}

    def proof(self, data):
        peer = public_key(data.get("sender"))
        gateway = origin(data.get("gateway"))
        with closing(self.library.connect()) as db:
            if not db.execute("SELECT 1 FROM share_friends WHERE key=? AND gateway=?", (peer, gateway)).fetchone():
                fail("Approve this friend before importing.")
        issued = data.get("issued")
        if type(issued) is not int:
            fail()
        payload = [peer, self.identity.key, gateway, token(data.get("token")), token(data.get("challenge")), issued]
        return {"key": self.identity.key, "issued": issued, "signature": self.identity.sign("open-share", payload)}

    def redeem(self, data, client):
        with closing(self.library.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = self.offer(db, data.get("token"), client)
            issued = data.get("issued")
            minute = int(time.time()) // 60
            if data.get("key") != row["recipient"] or type(issued) is not int or not minute - 2 <= issued <= minute:
                fail()
            self.identity.verify(row["recipient"], "open-share",
                                 [self.identity.key, row["recipient"], self.gateway, row["token"], row["challenge"], issued],
                                 data.get("signature"))
            if row["consumed"]:
                fail("This share has already been imported.", 409)
            lease = row["lease"] or secret()
            if not row["lease"]:
                db.execute("UPDATE share_offers SET lease=? WHERE token=?", (lease, row["token"]))
            manifest = json.loads(row["manifest"])
        return {"lease": lease, "manifest": manifest, "signature": self.identity.sign("share-manifest", manifest)}

    def chunk(self, data, client):
        with closing(self.library.connect()) as db:
            row = self.offer(db, data.get("token"), client)
        if row["consumed"] or not row["lease"] or not secrets.compare_digest(row["lease"], token(data.get("lease"))):
            fail()
        files = json.loads(row["files"])
        index, offset = data.get("index"), data.get("offset")
        if type(index) is not int or not 0 <= index < len(files) or type(offset) is not int:
            fail("Invalid transfer position.")
        document = files[index]
        with self.media_path(document["path"]).open("rb") as stream:
            info = os.fstat(stream.fileno())
            if fingerprint(info) != document["stat"] or not 0 <= offset < info.st_size:
                fail("The original song changed. Ask for a new link.", 409)
            stream.seek(offset)
            expected = min(CHUNK, info.st_size - offset)
            data = stream.read(expected)
            if len(data) != expected or fingerprint(os.fstat(stream.fileno())) != document["stat"]:
                fail("The original song changed. Ask for a new link.", 409)
            return data

    def finish(self, data, client):
        with closing(self.library.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = self.offer(db, data.get("token"), client)
            if not row["lease"] and not row["consumed"]:
                fail()
            self.identity.verify(row["recipient"], "import-receipt", [row["token"], digest(row["manifest"].encode())],
                                 data.get("receipt"))
            db.execute("UPDATE share_offers SET consumed=1,lease=NULL WHERE token=? AND consumed=0", (row["token"],))
        return {"complete": True}

    def validate_manifest(self, manifest):
        if not isinstance(manifest, dict) or manifest.get("recipient") != self.identity.key:
            fail("This share belongs to another Harbor.")
        token(manifest.get("token"))
        sender = public_key(manifest.get("sender"))
        gateway = origin(manifest.get("gateway"))
        kind, songs, expires = manifest.get("kind"), manifest.get("songs"), manifest.get("expires")
        if (kind not in ("song", "playlist") or not isinstance(songs, list) or not 0 < len(songs) <= MAX_TRACKS or
                kind == "song" and len(songs) != 1 or type(expires) is not int or expires <= int(time.time())):
            fail("This share is unavailable or has expired.")
        total = 0
        for track in songs:
            if (not isinstance(track, dict) or not isinstance(track.get("extension"), str) or
                    track["extension"] not in AUDIO_EXTENSIONS or
                    not isinstance(track.get("sha256"), str) or not SHA256.fullmatch(track["sha256"]) or
                    type(track.get("size")) is not int or not 0 < track["size"] <= MAX_FILE or
                    any(not isinstance(track.get(field), str) or len(track[field]) > 180 for field in ("title", "artist", "album"))):
                fail("Invalid audio manifest.")
            total += track["size"]
        if total > MAX_TOTAL:
            fail("This share is too large.", 413)
        return sender, gateway

    def folder(self, identifier):
        if not self.library.storage_available() or self.work.is_symlink() or not self.work.is_dir():
            fail("The music folder is unavailable.", 503)
        result = self.work / identifier
        result.mkdir(mode=0o700, exist_ok=True)
        if result.is_symlink() or not result.is_dir():
            fail("The transfer staging folder is unavailable.")
        return result

    def clear_parts(self, folder):
        if folder.is_symlink() or not folder.is_dir():
            return
        for path in folder.glob("*.part"):
            if re.fullmatch(r"[0-9]+\.part", path.name):
                path.unlink(missing_ok=True)
        try:
            folder.rmdir()
        except OSError:
            pass

    def pending_count(self, db):
        now = int(time.time())
        count = 0
        for row in db.execute("SELECT id,manifest FROM share_imports WHERE receipt IS NULL").fetchall():
            if json.loads(row["manifest"])["expires"] > now:
                count += 1
            elif SHA256.fullmatch(row["id"]):
                self.clear_parts(self.work / row["id"])
                db.execute("DELETE FROM share_imports WHERE id=?", (row["id"],))
        return count

    def existing(self, db, song, used=()):
        for row in db.execute("SELECT id,path FROM media WHERE kind='audio' AND size=?", (song["size"],)):
            if row["id"] in used:
                continue
            try:
                with self.media_path(row["path"]).open("rb") as stream:
                    if file_hash(stream, song["size"]) == song["sha256"]:
                        return row["id"]
            except (OSError, ShareError):
                continue
        return None

    def begin(self, data):
        manifest = data.get("manifest")
        sender, gateway = self.validate_manifest(manifest)
        identity = digest(encode([gateway, manifest["token"]]))
        serialized = encode(manifest).decode()
        with self.lock, closing(self.library.connect()) as db, db:
            if not self.library.storage_available() or self.work.is_symlink() or not self.work.is_dir():
                fail("The music folder is unavailable.", 503)
            self.require_friend(db, sender, gateway)
            self.identity.verify(sender, "share-manifest", manifest, data.get("signature"))
            row = db.execute("SELECT * FROM share_imports WHERE id=?", (identity,)).fetchone()
            if row and row["manifest"] != serialized:
                fail("This share changed. Ask for a new link.", 409)
            if row and row["receipt"]:
                return {"id": identity, "receipt": row["receipt"]}
            if self.pending_count(db) >= MAX_PENDING and not row:
                fail("Finish a pending import before starting another one.", 409)
            db.execute("INSERT OR IGNORE INTO share_imports VALUES (?,?,NULL)", (identity, serialized))
            folder = self.folder(identity)
            offsets, used = [], set()
            for index, song in enumerate(manifest["songs"]):
                if (existing := self.existing(db, song, used)):
                    used.add(existing)
                    offsets.append(song["size"])
                else:
                    part = folder / (str(index) + ".part")
                    offsets.append(part.stat().st_size if part.is_file() else 0)
        return {"id": identity, "offsets": offsets, "chunk": CHUNK}

    def preview(self, data):
        manifest = data.get("manifest")
        sender, gateway = self.validate_manifest(manifest)
        with closing(self.library.connect()) as db:
            self.require_friend(db, sender, gateway)
        self.identity.verify(sender, "share-manifest", manifest, data.get("signature"))
        return {"name": label(manifest.get("name"), "Shared music"), "songs": len(manifest["songs"])}

    @staticmethod
    def require_friend(db, key, gateway):
        if not db.execute("SELECT 1 FROM share_friends WHERE key=? AND gateway=?", (key, gateway)).fetchone():
            fail("Approve this friend before importing.")

    def import_row(self, db, identity):
        if not isinstance(identity, str) or not SHA256.fullmatch(identity):
            fail()
        row = db.execute("SELECT * FROM share_imports WHERE id=?", (identity,)).fetchone()
        if not row:
            fail("Import is unavailable.", 404)
        manifest = json.loads(row["manifest"])
        sender, gateway = self.validate_manifest(manifest)
        self.require_friend(db, sender, gateway)
        return row, manifest

    def part(self, headers, data):
        identity = headers.get("X-Harbor-Import", "")
        index, offset = headers.get("X-Harbor-Track", ""), headers.get("X-Harbor-Offset", "")
        if not re.fullmatch(r"[0-9]{1,3}", index) or not re.fullmatch(r"[0-9]{1,9}", offset):
            fail("Invalid transfer position.")
        index, offset = int(index), int(offset)
        with self.lock, closing(self.library.connect()) as db:
            row, manifest = self.import_row(db, identity)
            if row["receipt"] or not 0 <= index < len(manifest["songs"]):
                fail("This import is closed.", 409)
            size = manifest["songs"][index]["size"]
            if not 0 <= offset < size or len(data) != min(CHUNK, size - offset):
                fail("Invalid transfer size.")
            path = self.folder(identity) / (str(index) + ".part")
            flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
            with os.fdopen(os.open(path, flags, 0o640), "ab") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size != offset:
                    fail("Transfer position changed. Reopen the link to resume.", 409)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        return {"offset": offset + len(data)}

    def import_track(self, db, folder, index, song, used, now):
        existing = self.existing(db, song, used)
        if existing:
            return existing
        path = folder / (str(index) + ".part")
        # Use a deterministic name on the same volume for retry-safe publication.
        name = song["sha256"] + song["extension"]
        destination = self.imports / name
        for attempt in range(MAX_TRACKS):
            identifier = track_id(destination)
            if identifier not in used:
                break
            destination = self.imports / (str(attempt + 1) + "-" + name)
        else:
            fail("Too many repeated songs.", 409)
        source = path if path.is_file() else destination
        if source.is_symlink() or not source.is_file():
            fail("Download all songs before finishing.", 409)
        with source.open("rb") as stream:
            if not audio_header(stream, song["extension"]):
                fail("Harbor couldn’t recognize the received audio file.", 415)
            if file_hash(stream, song["size"]) != song["sha256"]:
                if source == path:
                    path.unlink()
                fail("A song failed verification. Reopen the link to retry.", 409)
        if source == path:
            try:
                os.link(path, destination, follow_symlinks=False)
            except FileExistsError:
                if destination.is_symlink() or not destination.is_file():
                    fail("An existing file conflicts with this import.", 409)
                with destination.open("rb") as stream:
                    if file_hash(stream, song["size"]) != song["sha256"]:
                        fail("An existing file conflicts with this import.", 409)
        info = destination.stat()
        db.execute("INSERT OR IGNORE INTO media "
                   "(id,path,kind,title,artist,album,size,mtime,created_at,updated_at) "
                   "VALUES (?,?,'audio',?,?,?,?,?,?,?)",
                   (identifier, str(destination), song["title"], song["artist"], song["album"],
                    info.st_size, info.st_mtime, now, now))
        stored = db.execute("SELECT id FROM media WHERE path=? AND kind='audio'", (str(destination),)).fetchone()
        if not stored or stored["id"] in used:
            fail("This song conflicts with the library.", 409)
        return stored["id"]

    def complete(self, data):
        identity = data.get("id")
        with self.lock, closing(self.library.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row, manifest = self.import_row(db, identity)
            if row["receipt"]:
                return {"receipt": row["receipt"]}
            if not self.library.storage_available():
                fail("The music folder is unavailable.", 503)
            folder = self.folder(identity)
            now = int(time.time())
            ids, used = [], set()
            for index, song in enumerate(manifest["songs"]):
                identifier = self.import_track(db, folder, index, song, used, now)
                ids.append(identifier)
                used.add(identifier)
            if manifest["kind"] == "playlist":
                title = label(manifest.get("name"), "Shared playlist")
                candidate, suffix = title, 1
                while db.execute("SELECT 1 FROM playlists WHERE name=? COLLATE NOCASE", (candidate,)).fetchone():
                    suffix += 1
                    candidate = f"{title[:155]} (shared {suffix})"
                playlist = secrets.token_hex(16)
                db.execute("INSERT INTO playlists VALUES (?,?,?)", (playlist, candidate, now))
                db.executemany("INSERT INTO playlist_items VALUES (?,?,?)",
                               ((playlist, identifier, now) for identifier in ids))
            receipt = self.identity.sign("import-receipt", [manifest["token"], digest(row["manifest"].encode())])
            db.execute("UPDATE share_imports SET receipt=? WHERE id=?", (receipt, identity))
        try:
            self.clear_parts(folder)
        except OSError:
            # The catalog and signed receipt remain valid if temporary cleanup fails.
            return {"receipt": receipt}
        return {"receipt": receipt}


class TransferHandler(BaseHTTPRequestHandler):
    server_version = "HarborTransfer"
    sys_version = ""

    def setup(self):
        self.request.settimeout(25)
        super().setup()

    def log_message(self, *_args):
        pass

    def reply(self, status, body, mime="application/json", client=None):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; "
                         "form-action 'none'; base-uri 'none'; frame-ancestors 'none'")
        if client:
            self.send_header("Access-Control-Allow-Origin", client)
            self.send_header("Vary", "Origin")
        if self.command == "OPTIONS":
            self.send_header("Access-Control-Allow-Methods", "POST")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        if not self.valid_host():
            self.reply(404, b"{}")
            return
        static = {"/invite": ("invite.html", "text/html; charset=utf-8"),
                  "/invite.css": ("invite.css", "text/css; charset=utf-8"),
                  "/invite.js": ("invite.js", "text/javascript; charset=utf-8")}
        if self.path not in static:
            self.reply(404, b"{}")
            return
        file, mime = static[self.path]
        self.reply(200, (Path(__file__).parent / "static" / "sharing" / file).read_bytes(), mime)

    def valid_host(self):
        return self.headers.get("Host", "").lower() == urlsplit(self.server.shares.gateway).netloc

    def do_OPTIONS(self):
        try:
            if not self.valid_host() or not self.path.startswith("/share/api/"):
                fail(status=404)
            self.reply(204, b"", client=origin(self.headers.get("Origin")))
        except ShareError as error:
            self.reply(error.status, b"{}")

    def do_POST(self):
        client = None
        try:
            shares = self.server.shares
            routes = {"/share/api/invite": shares.invite_info, "/share/api/request": shares.invite_request,
                      "/share/api/confirmation": shares.confirmation, "/share/api/challenge": shares.challenge,
                      "/share/api/redeem": shares.redeem, "/share/api/chunk": shares.chunk,
                      "/share/api/finish": shares.finish}
            if not self.valid_host() or self.path not in routes:
                fail(status=404)
            client = origin(self.headers.get("Origin"))
            result = routes[self.path](read_json(self), client)
            if isinstance(result, bytes):
                self.reply(200, result, "application/octet-stream", client)
            else:
                self.reply(200, encode(result), client=client)
        except ShareError as error:
            self.reply(error.status, encode({"error": str(error)}), client=client)
        except (OSError, sqlite3.Error, subprocess.SubprocessError, ValueError):
            self.reply(503, b'{"error":"The transfer service is unavailable."}', client=client)


class TransferServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, shares):
        super().__init__(("127.0.0.1", port), TransferHandler)
        self.shares = shares
        self.slots = threading.BoundedSemaphore(12)

    def process_request(self, request, address):
        if self.slots.acquire(blocking=False):
            super().process_request(request, address)
        else:
            self.shutdown_request(request)

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


def configured_sharing(library):
    gateway = os.environ.get("HARBOR_SHARE_ORIGIN")
    music = os.environ.get("HARBOR_MUSIC_ORIGIN")
    imports = os.environ.get("HARBOR_SHARE_IMPORT_DIR")
    if not (gateway or music or imports):
        return None, None
    if not (music and imports):
        raise RuntimeError("Harbor sharing needs a private HTTPS address and an import folder.")
    if not OPENSSL:
        raise RuntimeError("Install OpenSSL and add it to PATH to use friend sharing.")
    shares = Sharing(library, gateway, music, Path(imports))
    transfer = TransferServer(int(os.environ.get("HARBOR_SHARE_PORT", "8766")), shares) if gateway else None
    return shares, transfer
