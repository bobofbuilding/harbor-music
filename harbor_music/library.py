"""Index a music folder into a local SQLite catalog."""

import hashlib
import json
import logging
import math
import os
import sqlite3
import subprocess
import time
from contextlib import closing
from pathlib import Path

AUDIO_EXTENSIONS = {".aac", ".aif", ".aiff", ".alac", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".opus",
                    ".wav", ".wma"}
APPLICATION_ID = 0x484D5553
SCHEMA = f"""
PRAGMA application_id={APPLICATION_ID};
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind='audio'), title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '', album TEXT NOT NULL DEFAULT '',
    track INTEGER, disc INTEGER, duration REAL,
    genre TEXT, genre_mtime REAL, favorite INTEGER NOT NULL DEFAULT 0,
    available INTEGER NOT NULL DEFAULT 1,
    size INTEGER NOT NULL, mtime REAL NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS library_by_artist ON media(artist COLLATE NOCASE, album COLLATE NOCASE, disc, track);
CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS playlist_items (
    playlist_id TEXT NOT NULL REFERENCES playlists(id),
    media_id TEXT NOT NULL REFERENCES media(id),
    added_at INTEGER NOT NULL, PRIMARY KEY (playlist_id, media_id)
);
"""
SELECT_TRACK = "SELECT * FROM media WHERE id=? AND available=1"


def track_id(path):
    return hashlib.sha1(os.fsencode(path)).hexdigest()


def number(value):
    return int(value) if value.isascii() and value.isdigit() and len(value) <= 9 else None


def cleaned(value):
    return "".join(char for char in str(value) if char.isprintable()).strip()[:240]


class MusicLibrary:
    def __init__(self, root, state, ffprobe, mount_point=None):
        self.root = root
        self.db_path = state / "library.sqlite3"
        self.ffprobe = ffprobe
        self.mount_point = mount_point
        if not self.storage_available():
            raise ValueError("The music folder or its configured mount is unavailable.")
        with closing(self.connect()) as db, db:
            identifier = db.execute("PRAGMA application_id").fetchone()[0]
            if identifier != APPLICATION_ID and (
                identifier or db.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
            ):
                raise ValueError("This catalog belongs to another application. Use a new state directory.")
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)
            db.execute("INSERT OR IGNORE INTO settings VALUES ('music_root', ?)", (str(root),))
            saved_root = db.execute("SELECT value FROM settings WHERE key='music_root'").fetchone()[0]
            if saved_root != str(root):
                raise ValueError("This state directory belongs to a different music folder.")

    def connect(self):
        db = sqlite3.connect(self.db_path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    def storage_available(self):
        return self.root.is_dir() and (self.mount_point is None or self.mount_point.is_mount())

    def get_row(self, identifier):
        with closing(self.connect()) as db:
            return db.execute(SELECT_TRACK, (identifier,)).fetchone()

    def set_favorite(self, identifier, favorite):
        with closing(self.connect()) as db, db:
            db.execute("UPDATE media SET favorite=? WHERE id=?", (int(favorite), identifier))
            return db.execute("SELECT * FROM media WHERE id=?", (identifier,)).fetchone()

    def tags(self, path):
        try:
            result = subprocess.run(
                [self.ffprobe, "-v", "error", "-protocol_whitelist", "file", "-select_streams", "a", "-show_entries",
                 "format=duration:format_tags:stream=codec_type:stream_tags", "-of", "json", str(path)],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=12, check=True,
            )
            info = json.loads(result.stdout)
        except (OSError, ValueError, subprocess.SubprocessError):
            return {}, None
        file_format = info.get("format", {})
        tags = {}
        for section in [*info.get("streams", []), file_format]:
            tags.update({key.casefold(): cleaned(value) for key, value in section.get("tags", {}).items()})
        try:
            duration = float(file_format["duration"])
        except (KeyError, ValueError):
            duration = 0
        return tags, duration if math.isfinite(duration) and duration > 0 else None

    def metadata(self, path, previous):
        parts = path.relative_to(self.root).parts
        artist = cleaned(parts[-3]) if len(parts) >= 3 else ""
        album = cleaned(parts[-2]) if len(parts) >= 2 else ""
        defaults = previous or {"title": cleaned(path.stem), "artist": artist, "album": album}
        if not self.ffprobe:
            fields = ("track", "disc", "duration", "genre")
            return defaults["title"], defaults["artist"], defaults["album"], *(previous[key] if previous else None for key in fields)
        tags, duration = self.tags(path)
        title = tags.get("title") or defaults["title"]
        artist = tags.get("artist") or defaults["artist"]
        album = tags.get("album") or defaults["album"]
        track = number(tags.get("track", "").partition("/")[0])
        disc = number(tags.get("disc", "").partition("/")[0])
        return title, artist, album, track, disc, duration, tags.get("genre", "")

    def paths(self):
        def inaccessible(error):
            raise error

        for directory, dirs, files in os.walk(self.root, onerror=inaccessible):
            dirs[:] = sorted(name for name in dirs if not name.startswith("."))
            for name in sorted(files):
                path = Path(directory) / name
                if (not name.startswith(".") and path.suffix.lower() in AUDIO_EXTENSIONS and
                        not path.is_symlink() and path.is_file()):
                    yield path

    def scan(self):
        if not self.storage_available():
            return
        with closing(self.connect()) as db:
            existing = {row["path"]: row for row in db.execute("SELECT * FROM media")}
            for path in self.paths():
                entry = existing.get(str(path))
                try:
                    info = path.stat()
                except FileNotFoundError:
                    continue
                existing.pop(str(path), None)
                unchanged = entry and entry["size"] == info.st_size and entry["mtime"] == info.st_mtime
                if unchanged and (not self.ffprobe or entry["genre_mtime"] == info.st_mtime):
                    if not entry["available"]:
                        with db:
                            db.execute("UPDATE media SET available=1 WHERE id=?", (entry["id"],))
                    continue
                metadata = self.metadata(path, entry if unchanged or not self.ffprobe else None)
                probe_mtime = info.st_mtime if self.ffprobe else None
                now = int(time.time())
                with db:
                    db.execute("""
                        INSERT INTO media (id,path,kind,title,artist,album,track,disc,duration,genre,genre_mtime,
                                           size,mtime,created_at,updated_at)
                        VALUES (?,?,'audio',?,?,?,?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(path) DO UPDATE SET title=excluded.title, artist=excluded.artist,
                            album=excluded.album, track=excluded.track, disc=excluded.disc,
                            duration=excluded.duration, genre=excluded.genre, genre_mtime=excluded.genre_mtime,
                            size=excluded.size, mtime=excluded.mtime, updated_at=excluded.updated_at, available=1
                    """, (track_id(path), str(path), *metadata, probe_mtime, info.st_size, info.st_mtime, now, now))
            if self.storage_available():
                with db:
                    db.executemany("UPDATE media SET available=0 WHERE id=? AND mtime=? AND available=1",
                                   ((row["id"], row["mtime"]) for row in existing.values()))

    def watch(self, interval, stop):
        while not stop.is_set():
            try:
                self.scan()
            except (OSError, sqlite3.Error) as error:
                logging.warning("Music scan interrupted (%s). Retrying after %s seconds.", type(error).__name__, interval)
            stop.wait(interval)
