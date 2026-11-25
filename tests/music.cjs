const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomBytes } = require("node:crypto");
const { dirname, join } = require("node:path");
const { chromium, webkit, devices } = require(process.env.HARBOR_PLAYWRIGHT || "playwright");

const desktopURL = "http://127.0.0.1:28765";

const write = body => ({ data: body, headers: { "X-Harbor-Request": "music" } });
const poll = async (check, label) => {
  for (let i = 0; i < 60; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(label);
};

async function playlist(page, name, scope) {
  await page.locator("#playlist-form").getByLabel("Playlist name").fill(name);
  if (scope) await page.locator("#playlist-form").getByLabel("Keep this playlist").selectOption(scope);
  await page.getByRole("button", { name: "Save playlist" }).click();
}

async function exercise(engine, label) {
  const browser = await engine.launch();
  const desktop = await browser.newContext();
  const phoneURL = label === "WebKit" ? "https://localhost:28767" : "http://localhost:28766";
  const phone = await browser.newContext({
    ...devices["iPhone 13"], ignoreHTTPSErrors: label === "WebKit",
  });
  try {
    const mac = await desktop.newPage();
    const ios = await phone.newPage();
    await ios.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        this.muted = true;
        return play.apply(this, args);
      };
    });
    const player = ios.locator("#audio");
    const simulateOffline = async offline => {
      if (label !== "WebKit") return phone.setOffline(offline);
      // Playwright WebKit's synthetic offline mode rejects reloads before the
      // worker sees them with a test certificate. Take the local relay offline.
      const marker = process.env.HARBOR_TEST_OFFLINE_MARKER;
      if (offline) fs.writeFileSync(marker, "");
      else fs.rmSync(marker, { force: true });
      await ios.evaluate(value => window.dispatchEvent(new Event(value ? "offline" : "online")), offline);
    };
    const errors = [];
    for (const page of [mac, ios]) page.on("pageerror", error => errors.push(error.message));

    const malformedDesktop = await desktop.request.get(desktopURL + "/music/api/session", { headers: { Origin: "https://unrelated.test" } });
    assert.equal(malformedDesktop.status(), 403);
    const desktopApi = desktopURL + "/music/api/";
    const syncedName = label + " download playlist";
    const syncedId = randomBytes(16).toString("hex");
    const fixtureCatalog = async () => (await (await desktop.request.get(desktopApi + "tracks")).json()).items;
    await poll(async () => (await fixtureCatalog()).length === 2, "Fixture catalog");
    const [firstSong, secondSong] = ["Harbor Test Song", "Second Test Song"].map(
      title => ({ title, id: "" }),
    );
    for (const track of await fixtureCatalog()) {
      await desktop.request.post(desktopApi + "favorite", write({ id: track.id, favorite: false }));
      (track.title === firstSong.title ? firstSong : secondSong).id = track.id;
    }
    const seed = await desktop.request.post(desktopApi + "playlists",
      write({ id: syncedId, name: syncedName, base: null, tracks: [secondSong.id] }));
    assert.equal(seed.status(), 200);
    const { revision } = await seed.json();
    assert.equal((await phone.request.get(phoneURL + "/music/api/tracks")).status(), 401);
    assert.equal((await phone.request.post(phoneURL + "/music/api/playlists/delete",
      write({ id: syncedId, base: revision }))).status(), 401);
    await mac.goto(desktopURL + "/music/");
    await mac.getByRole("button", { name: "Devices", exact: true }).click();
    await mac.getByRole("dialog", { name: "Connected devices" }).waitFor();
    await poll(async () => /^[A-F0-9]{8}$/.test(await mac.locator("#pair-code").textContent()), "Pairing code");
    const code = await mac.locator("#pair-code").textContent();
    await ios.goto(phoneURL + "/");
    await player.evaluate(audio => { audio.muted = true; });
    await ios.getByLabel("Device name").fill(label + " phone");
    await ios.getByLabel("Pairing code").fill(code);
    await ios.getByRole("button", { name: "Connect", exact: true }).click();
    await ios.locator("#tracks .track").filter({ hasText: "Harbor Test Song" }).waitFor();
    await poll(async () => ios.evaluate(() => Boolean(navigator.serviceWorker.controller)), "Phone offline shell");
    assert.equal((await phone.request.get(phoneURL + "/api/files")).status(), 404);
    assert.equal((await phone.request.get(phoneURL + "/api/migrations")).status(), 404);
    const scoped = (await (await phone.request.get(phoneURL + "/music/api/playlists")).json()).playlists;
    assert.deepEqual(scoped.find(item => item.id === syncedId).tracks.map(track => track.id), [secondSong.id]);
    assert.equal((await phone.request.get(phoneURL + "/music/api/audio/" + "a".repeat(40))).status(), 404);
    assert.equal((await desktop.request.get(desktopURL + "/api/files")).status(), 404);
    assert.equal((await phone.request.post(phoneURL + "/music/api/pair-code", write({}))).status(), 404);
    assert.equal((await phone.request.get(phoneURL + "/music/api/devices")).status(), 404);
    assert.equal((await phone.request.post(phoneURL + "/music/api/pair", write({ code }))).status(), 403);

    await poll(async () => (await fixtureCatalog()).every(item => item.genre), "Genre tags indexed");
    await ios.getByRole("button", { name: "Filter & sort" }).click();
    const filter = ios.locator("#filter-dialog");
    await poll(async () => filter.getByLabel("Genre", { exact: true }).locator("option").filter({ hasText: "Jazz" }).count(), "Genre options");
    await filter.getByLabel("Genre", { exact: true }).selectOption("Jazz");
    await filter.getByLabel("Artist", { exact: true }).fill("tide");
    await filter.getByLabel("Album", { exact: true }).fill("night");
    await filter.getByLabel("Sort by").selectOption("album");
    await filter.getByRole("button", { name: "Apply" }).click();
    await ios.locator("#tracks .track").filter({ hasText: "Second Test Song" }).waitFor({ state: "hidden" });
    await ios.getByRole("button", { name: "Filter & sort" }).click();
    await filter.getByRole("button", { name: "Reset" }).click();
    await filter.getByLabel("Sort by").selectOption("title-desc");
    await filter.getByRole("button", { name: "Apply" }).click();
    await poll(async () => (await ios.locator("#tracks li .track-copy strong").allTextContents()).join() === "Second Test Song,Harbor Test Song", "Reverse alphabetical order");
    for (const [order, names] of [
      ["title", "Harbor Test Song,Second Test Song"],
      ["genre", "Harbor Test Song,Second Test Song"],
      ["artist", "Second Test Song,Harbor Test Song"],
      ["album", "Harbor Test Song,Second Test Song"],
    ]) {
      const listing = await (await phone.request.get(phoneURL + "/music/api/tracks?sort=" + order)).json();
      assert.equal(listing.items.map(track => track.title).join(), names);
    }

    await ios.locator("#tracks .track").filter({ hasText: "Harbor Test Song" }).click();
    const heart = ios.getByRole("button", { name: "Favorite current track", exact: true });
    assert.ok(await ios.evaluate(() => {
      const nav = document.querySelector(".tabs").getBoundingClientRect();
      const player = document.querySelector("#now-playing").getBoundingClientRect();
      return document.documentElement.scrollWidth <= window.innerWidth && player.bottom <= nav.top + 1;
    }), "The mobile tab bar and player fit without overlapping");
    await heart.click();
    await poll(async () => (await heart.getAttribute("aria-pressed")) === "true", "Now Playing favorite");
    await poll(async () => (await fixtureCatalog()).some(item => item.id === firstSong.id && item.favorite), "Synced favorite");
    await ios.getByRole("button", { name: "Favorites", exact: true }).click();
    await ios.locator("#tracks .track").filter({ hasText: "Harbor Test Song" }).waitFor();
    await ios.getByRole("button", { name: "Download settings", exact: true }).click();
    const downloadDialog = ios.locator("#download-dialog");
    await downloadDialog.getByRole("checkbox", { name: "Favorites", exact: true }).check();
    await downloadDialog.getByRole("checkbox", { name: syncedName, exact: true }).check();
    await downloadDialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await ios.getByRole("button", { name: "Downloads", exact: true }).click();
    await ios.locator("#tracks .track").filter({ hasText: "Harbor Test Song" }).waitFor();
    await ios.locator("#tracks .track").filter({ hasText: "Second Test Song" }).waitFor();
    await ios.getByRole("button", { name: "Download settings", exact: true }).click();
    assert.equal(await downloadDialog.getByRole("checkbox", { name: "Favorites", exact: true }).isChecked(), true);
    assert.equal(await downloadDialog.getByRole("checkbox", { name: syncedName, exact: true }).isChecked(), true);
    await downloadDialog.getByRole("button", { name: "Cancel", exact: true }).click();

    const catalog = await (await phone.request.get(phoneURL + "/music/api/tracks")).json();
    const media = catalog.items.find(track => track.title === "Harbor Test Song");
    assert.ok(media);
    const streamed = await phone.request.get(phoneURL + "/music/api/audio/" + media.id, { headers: { Range: "bytes=0-1" } });
    assert.equal(streamed.status(), 206);
    assert.equal((await streamed.body()).length, 2);
    assert.equal(streamed.headers()["content-range"], `bytes 0-1/${media.size}`);
    const tail = await phone.request.get(phoneURL + "/music/api/audio/" + media.id, { headers: { Range: "bytes=-4" } });
    assert.equal(tail.headers()["content-range"], `bytes ${media.size - 4}-${media.size - 1}/${media.size}`);
    assert.equal((await tail.body()).length, 4);
    const tooFar = await phone.request.get(phoneURL + "/music/api/audio/" + media.id,
      { headers: { Range: `bytes=${media.size}-` } });
    assert.equal(tooFar.status(), 416);
    assert.equal(tooFar.headers()["content-range"], `bytes */${media.size}`);
    assert.equal((await phone.request.head(phoneURL + "/music/api/audio/" + media.id)).status(), 200);

    await simulateOffline(true);
    await ios.reload({ waitUntil: "domcontentloaded" });
    await player.evaluate(audio => { audio.muted = true; });
    await ios.getByRole("button", { name: "Downloads", exact: true }).click();
    await ios.locator("#tracks .track").filter({ hasText: "Harbor Test Song" }).click();
    await poll(async () => player.evaluate(audio =>
      audio.currentSrc.startsWith("blob:") && audio.readyState >= 2 && audio.currentTime > 0), "Offline audio playback");
    assert.equal(await player.evaluate(audio => audio.muted), true);
    await ios.getByRole("button", { name: "Track options for Harbor Test Song", exact: true }).click();
    await ios.locator("#track-dialog").getByRole("button", { name: "Add to playlist", exact: true }).click();
    await ios.getByRole("button", { name: "New playlist" }).click();
    await playlist(ios, label + " offline synced", "synced");
    await ios.getByRole("button", { name: "Playlists", exact: true }).click();
    await ios.getByRole("button", { name: label + " offline synced", exact: true }).waitFor();
    await ios.getByRole("button", { name: "New playlist", exact: true }).click();
    await playlist(ios, label + " private list", "local");
    await ios.getByRole("heading", { name: label + " private list", exact: true }).waitFor();

    await ios.reload({ waitUntil: "domcontentloaded" });
    await ios.getByRole("button", { name: "Playlists", exact: true }).click();
    await ios.getByRole("button", { name: label + " private list", exact: true }).waitFor();
    await simulateOffline(false);
    const listURL = desktopURL + "/music/api/playlists";
    const shared = async () => (await (await desktop.request.get(listURL)).json()).playlists;
    await poll(async () => (await shared()).some(item => item.name === label + " offline synced"), "Queued playlist synced");
    assert.ok(!(await shared()).some(item => item.name === label + " private list"));
    const base = (await shared()).find(item => item.name === label + " offline synced");
    assert.equal(base.tracks[0].id, media.id);
    const conflict = await desktop.request.post(listURL, write({ id: base.id, name: label + " Mac edits", tracks: [media.id], base: base.revision }));
    assert.equal(conflict.status(), 200);
    await simulateOffline(true);
    await ios.getByRole("button", { name: label + " offline synced", exact: true }).click();
    await ios.getByRole("button", { name: "Edit", exact: true }).click();
    await playlist(ios, label + " Phone edits");
    await simulateOffline(false);
    await ios.getByRole("heading", { name: label + " Phone edits (my edits)", exact: true }).waitFor({ timeout: 10000 });
    assert.ok((await shared()).some(item => item.name === label + " Mac edits"));

    const deleteURL = phoneURL + "/music/api/playlists/delete";
    const confirm = ios.getByRole("dialog", { name: "Delete playlist?" });
    const askToDelete = async name => {
      await ios.getByRole("button", { name: "Playlists", exact: true }).click();
      await ios.getByRole("button", { name, exact: true }).click();
      await ios.getByRole("button", { name: "Edit", exact: true }).click();
      await ios.locator("#playlist-dialog").getByRole("button", { name: "Delete playlist", exact: true }).click();
    };
    const confirmDelete = () => confirm.getByRole("button", { name: "Delete playlist", exact: true }).click();
    const synced = (await shared()).find(item => item.id === base.id);
    const staleDelete = await phone.request.post(deleteURL, write({ id: synced.id, base: base.revision }));
    assert.equal(staleDelete.status(), 409);
    assert.equal((await staleDelete.json()).current.revision, synced.revision);

    await askToDelete(label + " private list");
    assert.match(await confirm.textContent(), /from this device/);
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await ios.locator("#playlist-dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await ios.getByRole("heading", { name: label + " private list", exact: true }).waitFor();
    assert.equal(await ios.getByRole("button", { name: "Edit", exact: true }).evaluate(async button => {
      await sync();
      return button.isConnected;
    }), true, "An unchanged sync leaves the playlist controls in place");
    await askToDelete(label + " private list");
    await confirmDelete();
    await ios.getByRole("heading", { name: "Playlists", exact: true }).waitFor();

    await simulateOffline(true);
    await askToDelete(synced.name);
    assert.match(await confirm.textContent(), /on all synced devices/);
    await confirmDelete();
    await ios.getByRole("heading", { name: "Playlists", exact: true }).waitFor();
    await ios.reload({ waitUntil: "domcontentloaded" });
    await ios.getByRole("button", { name: "Playlists", exact: true }).click();
    assert.equal(await ios.getByRole("button", { name: synced.name, exact: true }).count(), 0);
    assert.equal(await ios.getByRole("button", { name: label + " private list", exact: true }).count(), 0);
    assert.ok((await shared()).some(item => item.id === synced.id));
    await simulateOffline(false);
    await poll(async () => !(await shared()).some(item => item.id === synced.id), "Queued delete synced");
    assert.equal((await phone.request.post(deleteURL, write({ id: synced.id, base: synced.revision }))).status(), 200);
    assert.equal((await desktop.request.post(listURL, write({
      id: synced.id, name: synced.name, base: null, tracks: [media.id],
    }))).status(), 409);

    await askToDelete(syncedName);
    await confirmDelete();
    await poll(async () => !(await shared()).some(item => item.id === syncedId), "Synced playlist removed");
    await ios.getByRole("button", { name: "Downloads", exact: true }).click();
    await ios.locator("#tracks .track").filter({ hasText: "Harbor Test Song" }).waitFor();
    await ios.locator("#tracks .track").filter({ hasText: "Second Test Song" }).waitFor({ state: "hidden" });
    assert.equal((await fixtureCatalog()).length, 2);

    // Let the server recover while the browser still reports offline.
    let unavailable = true;
    const sessionRoute = "**/music/api/session";
    if (label === "WebKit") fs.writeFileSync(process.env.HARBOR_TEST_OFFLINE_MARKER, "");
    else await ios.route(sessionRoute, route => unavailable ? route.fulfill({ status: 503 }) : route.continue());
    await ios.evaluate(() => window.dispatchEvent(new Event("focus")));
    await poll(async () => (await ios.locator("#status").getAttribute("data-offline")) === "true",
      "Harbor detected an unreachable server");
    await ios.getByRole("button", { name: "Playlists", exact: true }).click();
    await ios.getByRole("button", { name: "New playlist", exact: true }).click();
    const recovered = label + " recovery playlist";
    await playlist(ios, recovered, "synced");
    await ios.getByRole("heading", { name: recovered, exact: true }).waitFor();
    assert.ok(!(await shared()).some(item => item.name === recovered));
    await ios.evaluate(() => {
      Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    });
    unavailable = false;
    if (label === "WebKit") fs.rmSync(process.env.HARBOR_TEST_OFFLINE_MARKER, { force: true });
    await poll(async () => (await shared()).some(item => item.name === recovered), "Timed reconnect synced the queued playlist");
    await poll(async () => (await ios.locator("#status").getAttribute("data-offline")) === "false",
      "Harbor reconnected without an online event");
    assert.equal(await ios.evaluate(() => navigator.onLine), false);
    await ios.evaluate(() => { delete navigator.onLine; });
    if (label !== "WebKit") await ios.unroute(sessionRoute);

    const connected = await (await desktop.request.get(desktopURL + "/music/api/devices")).json();
    const device = connected.devices.find(item => item.name === label + " phone");
    await desktop.request.post(desktopURL + "/music/api/revoke", write({ id: device.id }));
    assert.equal((await phone.request.get(phoneURL + "/music/api/tracks")).status(), 401);
    assert.deepEqual(errors, []);
    console.log(label + " passed pairing, music-only access, filters, Favorites, downloads, offline playback, playlist sync and deletion, conflicts, automatic reconnection, and revocation.");
  } finally {
    if (process.env.HARBOR_TEST_OFFLINE_MARKER) fs.rmSync(process.env.HARBOR_TEST_OFFLINE_MARKER, { force: true });
    await browser.close();
  }
}

async function exerciseScroll(engine, label) {
  const browser = await engine.launch();
  const iphone = await browser.newContext({ ...devices["iPhone 13"], ignoreHTTPSErrors: true });
  const pageFailure = join(dirname(process.env.HARBOR_TEST_OFFLINE_MARKER), "page-failure");
  try {
    const page = await iphone.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const calls = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname === "/music/api/tracks") calls.push(url.searchParams);
    });
    fs.writeFileSync(pageFailure, "");
    const url = desktopURL + "/music/api/tracks?sort=title&offset=";
    const loadFixture = async offset => (await (await iphone.request.get(url + offset)).json()).items;
    await poll(async () => (await loadFixture(200)).length === 52, "Fixture catalog ready");
    const items = [...await loadFixture(0), ...await loadFixture(100), ...await loadFixture(200)];
    assert.equal(items.length, 252);
    const create = await iphone.request.post(desktopURL + "/music/api/playlists", write({
      id: label === "Chromium" ? "a".repeat(32) : "b".repeat(32),
      name: label + " long playlist", base: null, tracks: items.map(track => track.id),
    }));
    assert.equal(create.status(), 200);
    const scrollToMarker = () => page.evaluate(() => {
      window.scrollTo(0, document.querySelector("#track-page").getBoundingClientRect().top + window.scrollY);
    });
    const offsets = () => calls.map(params => params.get("offset"));

    const pairing = await iphone.request.post(desktopURL + "/music/api/pair-code", write({}));
    const { code } = await pairing.json();
    await page.goto("https://localhost:28767/music/");
    await page.getByLabel("Pairing code").fill(code);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#tracks .track").filter({ hasText: "Harbor Test Song" }).waitFor();
    await page.waitForTimeout(400);
    assert.deepEqual(offsets(), ["0"]);
    assert.ok(await page.locator("#tracks li").count() < 60);

    await scrollToMarker();
    const retry = page.getByRole("button", { name: "Try again", exact: true });
    try {
      await retry.waitFor({ timeout: 9500 });
    } catch (error) {
      console.error(label, offsets(), await page.evaluate(() => ({
        y: scrollY, height: innerHeight, hidden: document.hidden,
        marker: document.querySelector("#track-page").getBoundingClientRect().top,
        note: document.querySelector("#page-status").textContent,
      })), errors);
      throw error;
    }
    assert.deepEqual(offsets(), ["0", "100"]);
    const lastFirstPage = page.locator("#tracks .track").filter({ hasText: "Paged track 098" });
    await lastFirstPage.waitFor();
    await retry.click();
    await poll(async () => offsets().length === 3 &&
      await page.locator("#tracks").evaluate(node => node.offsetHeight === 11600), "Second page rendered");
    await page.waitForTimeout(300);
    assert.deepEqual(offsets(), ["0", "100", "100"]);

    await scrollToMarker();
    await poll(async () => offsets().length === 4 && await page.locator("#track-page").isHidden(), "Final page loaded");
    assert.deepEqual(offsets(), ["0", "100", "100", "200"]);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.locator("#tracks .track").filter({ hasText: "Second Test Song" }).waitFor();
    assert.ok(await page.locator("#tracks li").count() < 60);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator("#tracks .track").filter({ hasText: "Harbor Test Song" }).waitFor();
    assert.deepEqual(offsets(), ["0", "100", "100", "200"]);

    await page.getByRole("searchbox", { name: "Search music" }).fill("Second Test Song");
    await poll(async () => (await page.locator("#tracks .track-copy strong").allTextContents()).join() === "Second Test Song", "Search reset the paging window");
    assert.equal(calls.at(-1).get("offset"), "0");
    assert.equal(calls.at(-1).get("q"), "Second Test Song");

    const beforePlaylist = calls.length;
    await page.getByRole("button", { name: "Playlists", exact: true }).click();
    await page.getByRole("button", { name: label + " long playlist", exact: true }).click();
    assert.ok(await page.locator("#tracks li").count() < 60);
    await poll(async () => {
      // A sync started when opening Playlists can redraw the selected list during the scroll.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      return page.locator("#tracks .track").filter({ hasText: "Second Test Song" }).isVisible();
    }, "The end of the long playlist was rendered");
    assert.ok(await page.locator("#tracks li").count() < 60);
    assert.equal(calls.length, beforePlaylist);
    assert.deepEqual(errors, []);
    console.log(label + " passed incremental loading, retry, search reset, and bounded library and playlist rendering.");
  } finally {
    fs.rmSync(pageFailure, { force: true });
    await browser.close();
  }
}

(async () => {
  if (process.argv[2]?.startsWith("scroll")) {
    if (process.argv[2] !== "scroll-webkit") await exerciseScroll(chromium, "Chromium");
    if (process.argv[2] !== "scroll-chromium") await exerciseScroll(webkit, "WebKit");
  } else {
    if (process.argv[2] !== "webkit") await exercise(chromium, "Chromium");
    if (process.argv[2] !== "chromium") await exercise(webkit, "WebKit");
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
