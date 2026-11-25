"""Adopt an existing music-only Harbor catalog while retaining device sessions."""

import argparse
import fcntl
import os
import sqlite3
from contextlib import closing
from pathlib import Path

from .library import APPLICATION_ID


REQUIRED_FIELDS = {
    "media": "id path kind title artist album track disc duration favorite size mtime created_at updated_at genre genre_mtime",
    "playlists": "id name created_at",
    "playlist_items": "playlist_id media_id added_at",
    "music_devices": "id token_hash name expires",
    "music_playback": "id generation writer sequence track_id position requested playlist",
    "music_playlist_deletions": "id",
}


def adopt(state, root, backup):
    catalog = state / "library.sqlite3"
    if not catalog.is_file() or not root.is_dir():
        raise ValueError("The existing catalog and music directory must be available.")
    if backup.exists() or backup == catalog:
        raise ValueError("Choose a new path for the catalog backup.")

    with (state / "server.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with closing(sqlite3.connect(catalog.as_uri() + "?mode=rw", uri=True)) as db, db:
            if db.execute("PRAGMA application_id").fetchone()[0] != 0:
                raise ValueError("This catalog already has an application identifier.")
            for table, fields in REQUIRED_FIELDS.items():
                actual = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
                if set(fields.split()) != actual:
                    raise ValueError(f"Unexpected legacy catalog fields in {table}.")
            prefix = str(root) + "/"
            if db.execute("SELECT 1 FROM media WHERE kind IS NOT 'audio' OR substr(path,1,?)!=? LIMIT 1",
                          (len(prefix), prefix)).fetchone():
                raise ValueError("Only a music-only catalog under the specified root can be adopted.")
            if db.execute("PRAGMA foreign_key_check").fetchone():
                raise ValueError("The existing catalog has broken references.")
            if db.execute("""
                SELECT 1 FROM playlist_items AS item
                LEFT JOIN playlists AS list ON list.id=item.playlist_id
                LEFT JOIN media ON media.id=item.media_id
                WHERE list.id IS NULL OR media.id IS NULL LIMIT 1
            """).fetchone():
                raise ValueError("The existing catalog has playlist entries without a song or playlist.")

            backup.touch(mode=0o600, exist_ok=False)
            with closing(sqlite3.connect(backup)) as snapshot:
                db.backup(snapshot)
                if snapshot.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                    raise ValueError("The catalog backup did not pass its integrity check.")

            db.execute("BEGIN IMMEDIATE")
            db.execute("ALTER TABLE media ADD COLUMN available INTEGER NOT NULL DEFAULT 1")
            db.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("INSERT INTO settings VALUES ('music_root', ?)", (str(root),))
            db.execute(f"PRAGMA application_id={APPLICATION_ID}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--backup", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        adopt(args.data_dir.expanduser().resolve(strict=True), args.root.expanduser().resolve(strict=True),
              args.backup.expanduser().resolve())
    except (OSError, ValueError, sqlite3.Error) as error:
        parser.exit(1, f"Harbor Music catalog adoption: {error}\n")
    print("Backed up and adopted the existing music catalog.")


if __name__ == "__main__":
    main()
