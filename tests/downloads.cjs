const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromium, webkit, devices } = require(process.env.HARBOR_PLAYWRIGHT || "playwright");

const admin = "http://127.0.0.1:28765/music/api/";
const write = data => ({ data, headers: { "X-Harbor-Request": "music" } });

async function poll(check) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("Harbor did not reach the expected state");
}

async function exercise(engine, label) {
  const browser = await engine.launch();
  const context = await browser.newContext({ ...devices["iPhone 13"], ignoreHTTPSErrors: true });
  const ios = await context.newPage();
  const webkitPhone = label === "WebKit";
  const phone = webkitPhone ? "https://localhost:28767" : "http://localhost:28766";
  const marker = process.env.HARBOR_TEST_OFFLINE_MARKER;
  const offline = async on => {
    if (webkitPhone) {
      if (on) fs.writeFileSync(marker, "");
      else fs.rmSync(marker, { force: true });
    } else await context.setOffline(on);
    await ios.evaluate(off => window.dispatchEvent(new Event(off ? "offline" : "online")), on);
  };
  const tab = name => ios.getByRole("button", { name, exact: true });
  const row = title => ios.locator("#tracks li").filter({ has: ios.getByText(title, { exact: true }) });
  const options = title => ios.getByRole("button", { name: "Track options for " + title, exact: true }).click();
  const cached = id => ios.evaluate(async trackId => Boolean(
    await (await caches.open("harbor-music-downloads")).match("/music/api/audio/" + trackId),
  ), id);
  const stored = id => ios.evaluate(trackId => new Promise((resolve, reject) => {
    const open = indexedDB.open("harbor-music", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const value = db.transaction("downloads").objectStore("downloads").get(trackId);
      value.onsuccess = () => { db.close(); resolve(value.result); };
      value.onerror = () => { db.close(); reject(value.error); };
    };
  }), id);
  const errors = [];
  const requests = new Map();
  ios.on("pageerror", error => errors.push(error.message));
  ios.on("request", request => {
    const id = new URL(request.url()).pathname.match(/^\/music\/api\/audio\/(.+)$/)?.[1];
    if (id) requests.set(id, (requests.get(id) || 0) + 1);
  });
  const response = async (action, code = 200) => {
    const result = await action;
    assert.equal(result.status(), code);
    return result.json();
  };
  try {
    let tracks;
    await poll(async () => {
      const items = (await response(context.request.get(admin + "tracks"))).items;
      tracks = new Map(items.map(track => [track.title, track.id]));
      return tracks.size === 5;
    });
    const [favorite, localAdd, remoteAdd, missed, unchecked] = [
      "Harbor Test Song", "Second Test Song", "From Another Device", "While Offline", "Unchecked Favorite",
    ];
    const id = name => tracks.get(name);
    for (const track of tracks.values()) {
      await response(context.request.post(admin + "favorite", write({ id: track, favorite: false })));
    }
    const name = label + " Auto Downloads";
    const playlistId = (webkitPhone ? "d" : "c").repeat(32);
    await response(context.request.post(admin + "playlists", write({ id: playlistId, name, base: null, tracks: [] })));
    const code = (await response(context.request.post(admin + "pair-code", write({})))).code;
    await ios.goto(phone + "/music/");
    await ios.getByLabel("Pairing code").fill(code);
    await tab("Connect").click();
    await row(favorite).waitFor();
    await ios.getByRole("button", { name: "Playlists", exact: true }).click();
    await tab(name).waitFor();
    await tab("Downloads").click();
    const settings = async (favorites, playlist = true) => {
      await tab("Download settings").click();
      const dialog = ios.locator("#download-dialog");
      await dialog.getByRole("checkbox", { name: "Favorites", exact: true }).setChecked(favorites);
      await dialog.getByRole("checkbox", { name, exact: true }).setChecked(playlist);
      await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    };
    await settings(true);
    await tab("Library").click();
    await row(favorite).getByRole("button", { name: "Favorite", exact: true }).click();
    await poll(() => stored(id(favorite)));
    await options(localAdd);
    await ios.locator("#track-dialog").getByRole("button", { name: "Add to playlist", exact: true }).click();
    await ios.locator("#add-dialog").getByRole("button", { name, exact: true }).click();
    await poll(() => stored(id(localAdd)));
    const shared = async () => (await response(context.request.get(admin + "playlists"))).playlists.find(item => item.id === playlistId);
    await poll(async () => (await shared()).tracks.length === 1);
    const revision = (await shared()).revision;
    await response(context.request.post(admin + "playlists", write({
      id: playlistId, name, base: revision, tracks: [id(localAdd), id(remoteAdd), id(favorite)],
    })));
    await tab("Playlists").click();
    await poll(() => stored(id(remoteAdd)));
    assert.equal(requests.get(id(favorite)), 1);

    await offline(true);
    await response(context.request.post(admin + "favorite", write({ id: id(missed), favorite: true })));
    assert.equal(await cached(id(missed)), false);
    await offline(false);
    await poll(() => stored(id(missed)));
    await tab("Downloads").click();
    await settings(false);
    await poll(async () => !(await stored(id(missed))));
    assert.equal(await cached(id(missed)), false);
    assert.equal(await cached(id(favorite)), true);
    await response(context.request.post(admin + "favorite", write({ id: id(unchecked), favorite: true })));
    await tab("Playlists").click();
    await tab(name).click();
    assert.equal(await cached(id(unchecked)), false);
    await tab("Downloads").click();
    await settings(true);
    await poll(async () => (await stored(id(unchecked))) && (await stored(id(missed))));
    await settings(true, false);
    await poll(async () => !(await stored(id(localAdd))) && !(await stored(id(remoteAdd))));
    for (const track of [localAdd, remoteAdd]) assert.equal(await cached(id(track)), false);
    for (const track of [favorite, missed, unchecked]) assert.equal(await cached(id(track)), true);
    await settings(true);
    await poll(async () => (await stored(id(localAdd))) && (await stored(id(remoteAdd))));

    await options(remoteAdd);
    await ios.locator("#track-dialog").getByRole("button", { name: "Remove download", exact: true }).click();
    await poll(async () => !(await stored(id(remoteAdd))));
    await ios.evaluate(trackId => new Promise((resolve, reject) => {
      const open = indexedDB.open("harbor-music", 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const transaction = db.transaction("downloads", "readwrite");
        const downloads = transaction.objectStore("downloads");
        const read = downloads.get(trackId);
        read.onsuccess = () => {
          const legacy = read.result;
          delete legacy.offlineFrom;
          downloads.put(legacy, trackId);
        };
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    }), id(localAdd));
    await ios.reload({ waitUntil: "domcontentloaded" });
    await tab("Playlists").click();
    await tab(name).click();
    await row(remoteAdd).waitFor();
    await options(remoteAdd);
    const download = ios.locator("#track-dialog").getByRole("button", { name: "Download track", exact: true });
    await download.waitFor();
    assert.equal(await cached(id(remoteAdd)), false);
    for (const track of [favorite, localAdd, missed, unchecked]) assert.equal(await cached(id(track)), true);
    await download.click();
    await poll(async () => (await stored(id(remoteAdd)))?.offlineFrom?.length === 0);
    await poll(async () => (await stored(id(localAdd)))?.offlineFrom?.includes(playlistId));

    await tab("Library").click();
    await row(favorite).getByRole("button", { name: "Favorite", exact: true, pressed: true }).click();
    await poll(async () => !(await stored(id(favorite)))?.offlineFrom?.includes("favorites"));
    assert.equal(await cached(id(favorite)), true);

    await tab("Playlists").click();
    await tab(name).click();
    await options(localAdd);
    await ios.locator("#track-dialog").getByRole("button", { name: "Remove from playlist", exact: true }).click();
    await poll(async () => !(await stored(id(localAdd))));
    assert.equal(await cached(id(localAdd)), false);

    const uncheckedPlaylist = (webkitPhone ? "f" : "e").repeat(32);
    await response(context.request.post(admin + "playlists", write({
      id: uncheckedPlaylist, name: label + " Unchecked Playlist", base: null, tracks: [id(favorite)],
    })));
    await response(context.request.post(admin + "playlists", write({
      id: playlistId, name, base: (await shared()).revision, tracks: [id(favorite), id(remoteAdd), id(unchecked)],
    })));
    await tab("Playlists").click();
    await poll(async () => (await stored(id(unchecked)))?.offlineFrom?.includes(playlistId));
    const deletionBase = (await shared()).revision;
    await offline(true);
    await response(context.request.post(admin + "playlists/delete", write({ id: playlistId, base: deletionBase })));
    assert.equal(await cached(id(favorite)), true);
    await offline(false);
    await poll(async () => !(await stored(id(favorite))));
    assert.equal(await cached(id(favorite)), false);
    assert.equal(await cached(id(remoteAdd)), true);
    assert.equal(await cached(id(unchecked)), true);

    await offline(true);
    await response(context.request.post(admin + "favorite", write({ id: id(missed), favorite: false })));
    assert.equal(await cached(id(missed)), true);
    await offline(false);
    await poll(async () => !(await stored(id(missed))));
    assert.equal(await cached(id(missed)), false);

    const localName = label + " This Device";
    await tab("Playlists").click();
    await tab("New playlist").click();
    const playlistDialog = ios.locator("#playlist-dialog");
    await playlistDialog.getByLabel("Playlist name").fill(localName);
    await playlistDialog.getByLabel("Keep this playlist").selectOption("local");
    await playlistDialog.getByRole("button", { name: "Save playlist", exact: true }).click();
    await tab("Library").click();
    await options(localAdd);
    await ios.locator("#track-dialog").getByRole("button", { name: "Add to playlist", exact: true }).click();
    await ios.locator("#add-dialog").getByRole("button", { name: localName, exact: true }).click();
    await tab("Downloads").click();
    await tab("Download settings").click();
    const downloadsDialog = ios.locator("#download-dialog");
    await downloadsDialog.getByRole("checkbox", { name: localName, exact: true }).check();
    await downloadsDialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await poll(() => stored(id(localAdd)));
    await tab("Playlists").click();
    await tab(localName).click();
    await tab("Edit").click();
    await playlistDialog.getByRole("button", { name: "Delete playlist", exact: true }).click();
    await ios.locator("#delete-playlist-dialog").getByRole("button", { name: "Delete playlist", exact: true }).click();
    await poll(async () => !(await stored(id(localAdd))));
    assert.equal(await cached(id(localAdd)), false);
    assert.equal(await cached(id(unchecked)), true);

    assert.equal((await response(context.request.get(admin + "tracks"))).total, 5);
    assert.deepEqual(errors, []);
    console.log(label + " passed automatic downloads, unchecking Favorites and playlists, local and remote playlist deletion, overlap, and manual downloads.");
  } finally {
    fs.rmSync(marker, { force: true });
    await browser.close();
  }
}

(async () => {
  await exercise(chromium, "Chromium");
  await exercise(webkit, "WebKit");
})().catch(error => { console.error(error); process.exitCode = 1; });
