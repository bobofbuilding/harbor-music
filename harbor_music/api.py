"""Harbor Music catalog, device pairing, playlists, and playback API."""

import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import threading
import time
from contextlib import closing
from http.cookies import CookieError, SimpleCookie
from urllib.parse import parse_qs, urlsplit

PREFIX = "/music/api/"
COOKIE = "harbor_music"
SESSION_SECONDS = 180 * 86400
MEDIA_ID = re.compile(r"[0-9a-f]{40}")
PLAYLIST_ID = re.compile(r"[0-9a-f]{32}")
TRACK_FIELDS = ("id", "title", "artist", "album", "track", "disc", "duration", "favorite", "size", "mtime", "genre")
ORDERS = {
    "title": "title COLLATE NOCASE ASC, artist COLLATE NOCASE ASC",
    "title-desc": "title COLLATE NOCASE DESC, artist COLLATE NOCASE ASC",
    "genre": "COALESCE(genre, '') = '', genre COLLATE NOCASE, title COLLATE NOCASE",
    "artist": "artist = '', artist COLLATE NOCASE, album COLLATE NOCASE, disc, track, title COLLATE NOCASE",
    "album": "album = '', album COLLATE NOCASE, artist COLLATE NOCASE, disc, track, title COLLATE NOCASE",
}
STATIC = {
    "/music/": "/music/index.html",
    "/music/music.css": "/music/music.css",
    "/music/music.js": "/music/music.js",
    "/music/sharing.js": "/music/sharing.js",
    "/music/worker.js": "/music/worker.js",
    "/music/manifest.webmanifest": "/music/manifest.webmanifest",
    "/music/icon.png": "/music/icon.png",
    "/harbor-media-logo.png": "/music/icon.png",
}


def track(row):
    return {key: row[key] for key in TRACK_FIELDS}


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class MusicAccess:
    def __init__(self, library, sharing=None):
        self.library = library
        self.sharing = sharing
        self.lock = threading.Lock()
        self.pair_hash = ""
        self.pair_deadline = 0
        self.pair_attempts = 0
        with closing(library.connect()) as db, db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS music_devices (
                    id TEXT PRIMARY KEY,
                    token_hash TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    expires INT NOT NULL
                )
            """)
            db.execute("CREATE TABLE IF NOT EXISTS music_playlist_deletions (id TEXT PRIMARY KEY)")
            db.execute("""
                CREATE TABLE IF NOT EXISTS music_playback (
                    id INTEGER PRIMARY KEY CHECK (id=1), generation INTEGER NOT NULL,
                    writer TEXT NOT NULL, sequence INTEGER NOT NULL, track_id TEXT NOT NULL,
                    position REAL NOT NULL, requested INTEGER NOT NULL, playlist TEXT
                )
            """)

    @staticmethod
    def track_selection(query):
        def value(name, default=""):
            return query.get(name, [default])[0].strip()[:240]

        conditions, params = ["available=1"], []
        if value("favorite") == "1":
            conditions.append("favorite = 1")
        for field in ("artist", "album"):
            group = query.get("group_" + field, [""])[0].strip()
            if group:
                conditions.append(f"music_fold(TRIM({field})) = ?")
                params.append(group.casefold())
            if value(field):
                conditions.append(f"instr(music_fold({field}), ?) > 0")
                params.append(value(field).casefold())
        if value("genre"):
            conditions.append("music_fold(genre) = ?")
            params.append(value("genre").casefold())
        if value("genre_missing") == "1":
            conditions.append("COALESCE(genre, '') = ''")
        if value("q"):
            conditions.append("instr(music_fold(title || ' ' || artist || ' ' || album || ' ' || COALESCE(genre, '')), ?) > 0")
            params.append(value("q").casefold())
        where = " AND ".join(conditions)
        order = ORDERS.get(value("sort", "artist"), ORDERS["artist"])
        return where, params, order

    def track_connection(self):
        db = self.library.connect()
        db.create_function("music_fold", 1, lambda text: (text or "").casefold(), deterministic=True)
        return db

    def list_tracks(self, query):
        try:
            offset = max(0, int(query.get("offset", ["0"])[0]))
        except ValueError:
            offset = 0
        where, params, order = self.track_selection(query)
        with closing(self.track_connection()) as db, db:
            db.execute("BEGIN")
            total = db.execute(f"SELECT COUNT(*) FROM media WHERE {where}", params).fetchone()[0]
            rows = db.execute(
                f"SELECT * FROM media WHERE {where} ORDER BY {order}, id LIMIT 100 OFFSET ?",
                [*params, min(offset, total)],
            )
            return {"items": [track(row) for row in rows], "total": total}

    def next_track(self, query):
        after = query.get("after", [""])[0]
        seed = query.get("shuffle", [""])[0]
        anchor = query.get("anchor", [""])[0]
        if not MEDIA_ID.fullmatch(after) or (seed and (
            not PLAYLIST_ID.fullmatch(seed) or not MEDIA_ID.fullmatch(anchor)
        )):
            raise ValueError("Invalid playback position.")
        where, params, order = self.track_selection(query)
        with closing(self.track_connection()) as db, db:
            if seed:
                def shuffle_rank(identifier):
                    return hashlib.sha256((seed + identifier).encode()).hexdigest()

                db.create_function("music_shuffle", 1, shuffle_rank, deterministic=True)
                after_rank = "" if after == anchor else shuffle_rank(after)
                row = db.execute(f"""
                    SELECT * FROM media
                    WHERE {where} AND id != ?
                      AND (music_shuffle(id) > ? OR (music_shuffle(id) = ? AND id > ?))
                    ORDER BY music_shuffle(id), id LIMIT 1
                """, [*params, anchor, after_rank, after_rank, after]).fetchone()
            else:
                row = db.execute(f"""
                    WITH ordered AS (
                        SELECT id, ROW_NUMBER() OVER (ORDER BY {order}, id) AS position
                        FROM media WHERE {where}
                    )
                    SELECT media.* FROM ordered JOIN media ON media.id = ordered.id
                    WHERE ordered.position = COALESCE((SELECT position + 1 FROM ordered WHERE id = ?), 1)
                """, [*params, after]).fetchone()
        return {"track": track(row) if row else None}

    def genre_options(self):
        with closing(self.library.connect()) as db, db:
            rows = db.execute("""
                SELECT genre FROM media WHERE available=1 AND genre!=''
                GROUP BY genre COLLATE NOCASE ORDER BY genre COLLATE NOCASE
            """)
            genres = list(dict.fromkeys(row[0] for row in rows))
        return {"genres": genres}

    def metadata(self, values):
        ids = values.get("ids")
        if not isinstance(ids, list) or not 0 < len(ids) <= 100 or any(
            not isinstance(item, str) or not MEDIA_ID.fullmatch(item) for item in ids
        ):
            raise ValueError("Invalid track list.")
        marks = ",".join("?" for _ in ids)
        with closing(self.library.connect()) as db, db:
            rows = db.execute(f"SELECT * FROM media WHERE available=1 AND id IN ({marks})", ids)
            return {"items": [track(row) for row in rows]}

    def device(self, handler):
        try:
            cookies = SimpleCookie(handler.headers.get("Cookie", ""))
            token = cookies.get(COOKIE)
        except CookieError:
            return None
        if not token or not re.fullmatch(r"[\w-]{43}", token.value, re.ASCII):
            return None
        with closing(self.library.connect()) as db, db:
            return db.execute(
                "SELECT id, name FROM music_devices WHERE token_hash=? AND expires>?",
                (digest(token.value), int(time.time())),
            ).fetchone()

    def create_pair_code(self):
        code = secrets.token_hex(4).upper()
        with self.lock:
            self.pair_hash = digest(code)
            self.pair_deadline = time.monotonic() + 300
            self.pair_attempts = 8
        return {"code": code, "expires_in": 300}

    def pair(self, handler, values):
        code = str(values.get("code", "")).strip().upper()
        name = str(values.get("name", "")).strip()[:80] or "Music device"
        with self.lock:
            if self.pair_deadline <= time.monotonic() or self.pair_attempts <= 0:
                handler.send_error_json(403, "Get a new pairing code from your media host.")
                return
            self.pair_attempts -= 1
            if not hmac.compare_digest(self.pair_hash, digest(code)):
                handler.send_error_json(403, "Check the pairing code and try again.")
                return
            token = secrets.token_urlsafe(32)
            previous = self.device(handler)
            with closing(self.library.connect()) as db, db:
                db.execute("DELETE FROM music_devices WHERE expires<=?", (int(time.time()),))
                if previous:
                    db.execute("DELETE FROM music_devices WHERE id=?", (previous["id"],))
                db.execute(
                    "INSERT INTO music_devices VALUES (?, ?, ?, ?)",
                    (secrets.token_hex(16), digest(token), name, int(time.time()) + SESSION_SECONDS),
                )
            self.pair_deadline = 0
        handler.send_json(
            {"paired": True},
            extra_headers={"Set-Cookie": (
                f"{COOKIE}={token}; Path=/music/; HttpOnly; Secure; SameSite=Strict; Max-Age={SESSION_SECONDS}"
            )},
        )

    @staticmethod
    def snapshot(db, playlist):
        rows = db.execute(
            "SELECT m.* FROM playlist_items AS p JOIN media AS m ON m.id=p.media_id "
            "WHERE p.playlist_id=? ORDER BY p.added_at, p.rowid",
            (playlist["id"],),
        )
        tracks = [track(row) for row in rows]
        revision = digest(json.dumps([playlist["name"], [item["id"] for item in tracks]]))
        return {"id": playlist["id"], "name": playlist["name"], "revision": revision, "tracks": tracks}

    def playlists(self):
        with closing(self.library.connect()) as db, db:
            db.execute("BEGIN")
            playlists = db.execute("SELECT id, name FROM playlists ORDER BY name COLLATE NOCASE")
            return [self.snapshot(db, playlist) for playlist in playlists]

    def sync_playlist(self, values):
        identifier = values.get("id")
        name = values.get("name")
        ids = values.get("tracks")
        if not isinstance(identifier, str) or not PLAYLIST_ID.fullmatch(identifier):
            raise ValueError("Invalid playlist.")
        if not isinstance(name, str) or not 0 < len(name.strip()) <= 180:
            raise ValueError("Enter a playlist name of 1–180 characters.")
        if not isinstance(ids, list) or len(ids) > 25000 or any(
            not isinstance(item, str) or not MEDIA_ID.fullmatch(item) for item in ids
        ) or len(set(ids)) != len(ids):
            raise ValueError("Invalid playlist tracks.")
        name = name.strip()
        with closing(self.library.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT id, name FROM playlists WHERE id=?", (identifier,)).fetchone()
            current = self.snapshot(db, row) if row else None
            if not current and db.execute("SELECT 1 FROM music_playlist_deletions WHERE id=?", (identifier,)).fetchone():
                return 409, {"error": "This playlist was deleted on another device.", "current": None}
            if current and name == current["name"] and ids == [item["id"] for item in current["tracks"]]:
                return 200, current  # A previous request may have succeeded before its response arrived.
            base = current["revision"] if current else None
            if values.get("base") != base:
                return 409, {"error": "The playlist changed on another device.", "current": current}
            if db.execute(
                "SELECT 1 FROM playlists WHERE name=? COLLATE NOCASE AND id!=?", (name, identifier)
            ).fetchone():
                return 409, {"error": "A synced playlist already has this name.", "current": current}
            valid = set()
            for offset in range(0, len(ids), 500):
                block = ids[offset:offset + 500]
                marks = ",".join("?" for _ in block)
                valid.update(row[0] for row in db.execute(
                    f"SELECT id FROM media WHERE id IN ({marks})", block
                ))
            if len(valid) != len(ids):
                return 409, {"error": "Some tracks are unavailable in the shared library.", "current": current}
            db.execute(
                "INSERT INTO playlists (id,name,created_at) VALUES (?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET name=excluded.name",
                (identifier, name, int(time.time())),
            )
            db.execute("DELETE FROM playlist_items WHERE playlist_id=?", (identifier,))
            db.executemany(
                "INSERT INTO playlist_items (playlist_id,media_id,added_at) VALUES (?,?,?)",
                ((identifier, item, int(time.time())) for item in ids),
            )
            return 200, self.snapshot(db, {"id": identifier, "name": name})

    def delete_playlist(self, values):
        identifier, base = values.get("id"), values.get("base")
        if not isinstance(identifier, str) or not PLAYLIST_ID.fullmatch(identifier):
            raise ValueError("Invalid playlist.")
        if "base" not in values or (base is not None and (
            not isinstance(base, str) or not re.fullmatch(r"[0-9a-f]{64}", base)
        )):
            raise ValueError("Invalid playlist revision.")
        with closing(self.library.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT id, name FROM playlists WHERE id=?", (identifier,)).fetchone()
            if row:
                current = self.snapshot(db, row)
                if current["revision"] != base:
                    return 409, {"error": "The playlist changed on another device. Review it before deleting.", "current": current}
                db.execute("DELETE FROM playlist_items WHERE playlist_id=?", (identifier,))
                db.execute("DELETE FROM playlists WHERE id=?", (identifier,))
            db.execute("INSERT OR IGNORE INTO music_playlist_deletions (id) VALUES (?)", (identifier,))
            return 200, {"deleted": True}

    @staticmethod
    def playback_snapshot(db, row):
        if row is None:
            return {"generation": 0, "writer": None, "bookmark": None}
        song = db.execute("SELECT * FROM media WHERE available=1 AND id=?", (row["track_id"],)).fetchone()
        bookmark = {"track": track(song), "position": row["position"], "requested": bool(row["requested"]),
                    "playlist": row["playlist"]} if song else None
        return {"generation": row["generation"], "writer": row["writer"], "bookmark": bookmark}

    def playback(self, values=None):
        with closing(self.library.connect()) as db, db:
            if values is not None:
                db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM music_playback WHERE id=1").fetchone()
            if values is None:
                return 200, self.playback_snapshot(db, row)
            writer, generation = values.get("writer"), values.get("generation")
            sequence, claim = values.get("sequence"), values.get("claim")
            identifier, position = values.get("track"), values.get("position")
            requested, playlist = values.get("requested"), values.get("playlist")
            if (not isinstance(writer, str) or not PLAYLIST_ID.fullmatch(writer) or
                    type(generation) is not int or not 0 <= generation < 2**53 - 1 or
                    type(sequence) is not int or not 0 < sequence < 2**53 or type(claim) is not bool or
                    not isinstance(identifier, str) or not MEDIA_ID.fullmatch(identifier) or
                    type(position) not in (int, float) or not 0 <= position <= 604800 or
                    type(requested) is not bool or
                    (playlist is not None and (not isinstance(playlist, str) or not PLAYLIST_ID.fullmatch(playlist)))):
                raise ValueError("Invalid playback position.")
            same_writer = row is not None and row["writer"] == writer
            latest_generation = row["generation"] if row else 0
            if generation != latest_generation or (not same_writer and not claim):
                return 409, {"error": "Playback has moved to another device.", "current": self.playback_snapshot(db, row)}
            if same_writer and sequence <= row["sequence"]:
                return 200, self.playback_snapshot(db, row)
            if not db.execute("SELECT 1 FROM media WHERE available=1 AND id=?", (identifier,)).fetchone():
                raise ValueError("This song is unavailable.")
            if playlist and not db.execute("SELECT 1 FROM playlist_items WHERE playlist_id=? AND media_id=?",
                                           (playlist, identifier)).fetchone():
                playlist = None
            db.execute("""
                INSERT INTO music_playback VALUES (1,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET generation=excluded.generation, writer=excluded.writer,
                    sequence=excluded.sequence, track_id=excluded.track_id, position=excluded.position,
                    requested=excluded.requested, playlist=excluded.playlist
            """, (latest_generation + int(not same_writer), writer, sequence, identifier, position, requested, playlist))
            return 200, self.playback_snapshot(db, db.execute("SELECT * FROM music_playback WHERE id=1").fetchone())

    def handle(self, handler):
        request = urlsplit(handler.path)
        owner = handler.server.owner
        path, method = request.path, handler.command
        if method in ("GET", "HEAD") and path in ("/music", "/"):
            handler.send_response(302)
            handler.send_header("Location", "/music/")
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return True
        if method in ("GET", "HEAD") and path in STATIC:
            handler.serve_static(STATIC[path])
            return True
        if not path.startswith(PREFIX):
            handler.send_error_json(404, "This Harbor connection is for music.")
            return True

        endpoint = path[len(PREFIX):]
        share_origin = self.sharing and self.sharing.music_origin == "https://" + handler.headers.get("Host", "").lower()
        if endpoint.startswith("sharing/"):
            if not share_origin:
                handler.send_error_json(404, "Sharing is unavailable at this address.")
            elif not owner and not self.device(handler):
                handler.send_error_json(401, "Pair this device with Harbor first.")
            elif method == "POST" and handler.headers.get("X-Harbor-Request") != "music":
                handler.send_error_json(403, "Open Harbor to make changes.")
            else:
                self.sharing.private(handler, endpoint.removeprefix("sharing/"))
            return True
        if method == "POST":
            if handler.headers.get("X-Harbor-Request") != "music" or handler.headers.get_content_type() != "application/json":
                handler.send_error_json(403, "Open Harbor to make changes.")
                return True
            try:
                length = int(handler.headers.get("Content-Length", "0"))
                if not 0 < length <= 2_000_000:
                    raise ValueError("Invalid request size.")
                data = handler.read_json()
                if not isinstance(data, dict):
                    raise ValueError("Invalid request.")
            except (ValueError, TypeError):
                handler.send_error_json(400, "Invalid request.")
                return True
        if not owner and method == "POST" and endpoint == "pair":
            self.pair(handler, data)
            return True
        paired = owner or bool(self.device(handler))
        if method == "GET" and endpoint == "session":
            # Older installed players still read desktop until their worker updates.
            session = {"paired": paired, "owner": owner, "desktop": owner}
            if paired and share_origin:
                session["sharing"] = True
                session["share_sending"] = bool(self.sharing.gateway)
            handler.send_json(session)
        elif not paired:
            handler.send_error_json(401, "Enter the pairing code from your media host.")
        elif owner and method == "POST" and endpoint == "pair-code":
            handler.send_json(self.create_pair_code())
        elif owner and method == "GET" and endpoint == "devices":
            with closing(self.library.connect()) as db, db:
                devices = [dict(row) for row in db.execute(
                    "SELECT id, name FROM music_devices WHERE expires>? ORDER BY name", (int(time.time()),)
                )]
            handler.send_json({"devices": devices})
        elif owner and method == "POST" and endpoint == "revoke":
            with closing(self.library.connect()) as db, db:
                db.execute("DELETE FROM music_devices WHERE id=?", (str(data.get("id", "")),))
            handler.send_json({"revoked": True})
        elif endpoint == "playback" and method in ("GET", "POST"):
            try:
                status, result = self.playback(data if method == "POST" else None)
                handler.send_json(result, status)
            except ValueError as exc:
                handler.send_error_json(400, str(exc))
        elif method == "GET" and endpoint == "tracks":
            handler.send_json(self.list_tracks(parse_qs(request.query)))
        elif method == "GET" and endpoint == "next-track":
            try:
                handler.send_json(self.next_track(parse_qs(request.query)))
            except ValueError as exc:
                handler.send_error_json(400, str(exc))
        elif method == "GET" and endpoint == "genres":
            handler.send_json(self.genre_options())
        elif method == "POST" and endpoint == "metadata":
            try:
                handler.send_json(self.metadata(data))
            except ValueError as exc:
                handler.send_error_json(400, str(exc))
        elif method == "GET" and endpoint == "playlists":
            handler.send_json({"playlists": self.playlists()})
        elif method == "POST" and endpoint == "playlists":
            try:
                status, result = self.sync_playlist(data)
                handler.send_json(result, status)
            except (ValueError, sqlite3.IntegrityError) as exc:
                handler.send_error_json(400, str(exc))
        elif method == "POST" and endpoint == "playlists/delete":
            try:
                status, result = self.delete_playlist(data)
                handler.send_json(result, status)
            except ValueError as exc:
                handler.send_error_json(400, str(exc))
        elif method == "POST" and endpoint == "favorite":
            row = self.library.get_row(str(data.get("id", "")))
            if not row or not isinstance(data.get("favorite"), bool):
                handler.send_error_json(404, "Track unavailable.")
            else:
                handler.send_json(track(self.library.set_favorite(row["id"], data["favorite"])))
        elif method in ("GET", "HEAD") and endpoint.startswith("audio/"):
            identifier = endpoint.removeprefix("audio/")
            row = self.library.get_row(identifier) if MEDIA_ID.fullmatch(identifier) else None
            if not row:
                handler.send_error_json(404, "Track unavailable.")
            else:
                handler.serve_audio(row)
        else:
            handler.send_error_json(404, "Music command unavailable.")
        return True
