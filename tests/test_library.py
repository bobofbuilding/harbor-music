import shutil
import sqlite3
import tempfile
import unittest
import wave
from contextlib import closing
from pathlib import Path

from harbor_music.api import MusicAccess
from harbor_music.library import MusicLibrary, track_id


def make_song(path, frames):
    with wave.open(str(path), "wb") as song:
        song.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        song.writeframes(bytes(frames * 2))


class MusicLibraryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name).resolve()
        self.root = self.folder / "music"
        self.state = self.folder / "state"
        self.album = self.root / "Fixture Artist" / "Fixture Album"
        self.album.mkdir(parents=True)
        self.state.mkdir()

    def test_scan_preserves_playlists_and_favorites_when_tracks_disappear(self):
        ffprobe = shutil.which("ffprobe")
        if not ffprobe:
            self.fail("Run the catalog test with ffprobe on PATH.")
        path = self.album / "Test Song.wav"
        make_song(path, 8000)
        identifier = track_id(path)
        external = self.folder / "Outside.wav"
        make_song(external, 8000)
        (self.album / "Linked.wav").symlink_to(external)
        (self.album / "image.png").touch()

        library = MusicLibrary(self.root, self.state, ffprobe)
        access = MusicAccess(library)
        library.scan()
        self.assertEqual(access.list_tracks({})["total"], 1)
        row = library.get_row(identifier)
        self.assertEqual((row["title"], row["artist"], row["album"], row["duration"]),
                         ("Test Song", "Fixture Artist", "Fixture Album", 1.0))
        library.set_favorite(identifier, True)
        status, _ = access.sync_playlist({"id": "a" * 32, "base": None, "name": "Songs", "tracks": [identifier]})
        self.assertEqual(status, 200)

        path.unlink()
        library.scan()
        self.assertEqual(access.list_tracks({})["total"], 0)
        self.assertEqual(access.playlists()[0]["tracks"][0]["id"], identifier)

        make_song(path, 16000)
        library.scan()
        restored = access.list_tracks({"favorite": ["1"]})["items"]
        self.assertEqual([(row["id"], row["duration"]) for row in restored], [(identifier, 2.0)])

    def test_existing_unrelated_database_is_rejected_without_schema_changes(self):
        database = self.state / "library.sqlite3"
        with closing(sqlite3.connect(database)) as db, db:
            db.execute("CREATE TABLE original (value TEXT)")
        before = database.read_bytes()
        with self.assertRaisesRegex(ValueError, "belongs to another application"):
            MusicLibrary(self.root, self.state, "ffprobe")
        self.assertEqual(database.read_bytes(), before)
