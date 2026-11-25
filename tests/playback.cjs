const assert = require("node:assert/strict");
const { createHash, X509Certificate } = require("node:crypto");
const fs = require("node:fs");
const { dirname, join } = require("node:path");
const { chromium, webkit, devices } = require(process.env.HARBOR_PLAYWRIGHT || "playwright");

const desktop = "http://127.0.0.1:28765/music/api/";
const phone = "https://localhost:28767/music/";
const authorized = { "X-Harbor-Request": "music" };
const offlineMarker = process.env.HARBOR_TEST_OFFLINE_MARKER;

async function until(check, name) {
  for (let i = 0; i < 60; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(name);
}

function rank(seed, id) {
  return createHash("sha256").update(seed + id).digest("hex");
}

function shuffleFirst(items, seed, anchor) {
  return items.filter(item => item.id !== anchor.id)
    .map(item => [rank(seed, item.id), item])
    .sort(([left], [right]) => left.localeCompare(right))[0]?.[1];
}

function seedBeyondFirstPage(items, anchor) {
  for (let i = 1; i <= 100; i++) {
    const seed = i.toString(16).padStart(32, "0");
    const track = shuffleFirst(items, seed, anchor);
    if (items.indexOf(track) >= 101) return { seed, track };
  }
  throw new Error("Could not create the deterministic later-page shuffle fixture");
}

async function setSeed(page, seed) {
  await page.evaluate(value => {
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: () => value });
  }, seed);
}

async function exercise(engine, label) {
  const certificate = new X509Certificate(fs.readFileSync(join(dirname(offlineMarker), "cert.pem")));
  const pin = createHash("sha256").update(certificate.publicKey.export({ type: "spki", format: "der" })).digest("base64");
  const browser = await engine.launch(label === "Chromium" ? {
    args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors-spki-list=" + pin],
  } : {});
  try {
    const context = await browser.newContext({
      ...devices["iPhone 13"], viewport: { width: 320, height: 568 }, ignoreHTTPSErrors: true,
    });
    await context.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      const saved = JSON.parse(localStorage.getItem("harbor-music-playback-v1"));
      window.harborPlayObserved = { initial: saved?.requested, position: saved?.position, start: null, failures: [] };
      let blocked = false;
      HTMLMediaElement.prototype.play = function (...args) {
        this.muted = true;
        this.addEventListener("playing", () => {
          window.harborPlayObserved.start ??= this.currentTime;
        }, { once: true });
        if (!blocked && sessionStorage.getItem("harbor-test-block-autoplay")) {
          blocked = true;
          return Promise.reject(new DOMException("Test autoplay restriction", "NotAllowedError"));
        }
        return play.apply(this, args).catch(error => {
          window.harborPlayObserved.failures.push(error.name);
          throw error;
        });
      };
      const actions = new Map();
      const media = navigator.mediaSession;
      const register = media.setActionHandler.bind(media);
      media.setActionHandler = (action, handler) => {
        register(action, handler);
        if (handler) actions.set(action, handler);
        else actions.delete(action);
      };
      if (!navigator.audioSession) Object.defineProperty(navigator, "audioSession", { value: { type: "auto" } });
      window.harborMediaActions = actions;
      window.harborBackground = hidden => {
        Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
        document.dispatchEvent(new Event("visibilitychange"));
      };
    });
    const page = await context.newPage();
    const errors = [];
    let phase = "order and shuffle";
    const captureErrors = current => current.on("pageerror", error => errors.push({
      phase, message: error.message, stack: error.stack,
    }));
    const browsePages = [];
    const nextLookups = [];
    captureErrors(page);
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname === "/music/api/tracks") browsePages.push(url.searchParams.get("offset"));
      if (url.pathname === "/music/api/next-track") nextLookups.push(url.searchParams.get("after"));
    });
    const list = async suffix => (await (await context.request.get(desktop + "tracks?" + suffix)).json()).items;
    await until(async () => (await list("sort=title&offset=100")).length === 32, "Fixture library indexed");
    const all = [...await list("sort=title&offset=0"), ...await list("sort=title&offset=100")];
    const album = [...await list("sort=album&group_album=Paging+Album&offset=0"),
      ...await list("sort=album&group_album=Paging+Album&offset=100")];
    const playlistName = label + " order and shuffle";
    const members = [all[9], all[5], all[7]];
    const create = await context.request.post(desktop + "playlists", {
      headers: authorized, data: {
        id: label === "Chromium" ? "c".repeat(32) : "d".repeat(32),
        name: playlistName, base: null, tracks: members.map(track => track.id),
      },
    });
    assert.equal(create.status(), 200);

    const codeResponse = await context.request.post(desktop + "pair-code", { headers: authorized, data: {} });
    const { code } = await codeResponse.json();
    await page.goto(phone);
    await page.getByLabel("Pairing code").fill(code);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await until(async () => page.locator("#tracks").evaluate(node => node.offsetHeight === 5800), "First browse page");
    const next = page.getByRole("button", { name: "Next track", exact: true });
    const prev = page.getByRole("button", { name: "Previous track", exact: true });
    const mode = page.getByRole("button", { name: "Shuffle playback", exact: true });
    const playing = () => page.locator("#playing-title").textContent();
    const checkSong = track => until(async () => (await playing()) === track.title, "Expected track is playing");
    const playRow = track => page.locator('#tracks li[data-track-id="' + track.id + '"] .track').tap();
    const mediaAction = (action, details = {}) => page.evaluate(([name, data]) =>
      window.harborMediaActions.get(name)(data), [action, details]);
    const background = hidden => page.evaluate(value => window.harborBackground(value), hidden);
    await page.locator("#audio").evaluate(audio => { audio.muted = true; });
    // Start the last loaded item without scrolling the browsing page into page two.
    await page.evaluate(() => startPlayback(displayedTracks, 99));
    await checkSong(all[99]);
    assert.equal(await mode.getAttribute("aria-pressed"), "false");
    const audio = page.locator("#audio");
    await until(async () => audio.evaluate(element => element.currentTime > 0), "Streaming started");
    const initial = await audio.evaluate(element => element.currentTime);
    await background(true);
    await until(async () => nextLookups.includes(all[99].id), "Looked up the next song before the current song ended");
    await until(async () => audio.evaluate((element, before) => element.currentTime > before + .2, initial),
      "Playback continued when the page was hidden");
    assert.deepEqual(await page.evaluate(() => [navigator.audioSession.type, navigator.mediaSession.metadata.title,
      navigator.mediaSession.playbackState]), ["playback", all[99].title, "playing"]);
    await mediaAction("pause");
    await until(async () => page.evaluate(() => navigator.mediaSession.playbackState === "paused"), "Media action paused playback");
    assert.equal(await audio.evaluate(element => element.paused), true);
    await mediaAction("seekto", { seekTime: 2 });
    await until(async () => audio.evaluate(element => Math.abs(element.currentTime - 2) < .1), "Media action sought while paused");
    await mediaAction("play");
    await until(async () => audio.evaluate(element => !element.paused && element.currentTime > 2), "Media action resumed playback");
    await mediaAction("nexttrack");
    await checkSong(all[100]);
    assert.equal(await prev.isEnabled(), true);
    assert.equal(nextLookups.filter(after => after === all[99].id).length, 1);
    await background(false);
    assert.deepEqual(browsePages, ["0"]);

    const fullShuffle = seedBeyondFirstPage(all, all[100]);
    await setSeed(page, fullShuffle.seed);
    await mode.click();
    assert.equal(await mode.getAttribute("aria-pressed"), "true");
    await next.click();
    await checkSong(fullShuffle.track);
    await mediaAction("previoustrack");
    await checkSong(all[100]);
    await next.click();
    await checkSong(fullShuffle.track);
    assert.deepEqual(browsePages, ["0"]);

    const filtered = all.filter(item => item.title.startsWith("Paged track 1"));
    await page.getByRole("searchbox", { name: "Search music" }).fill("Paged track 1");
    await until(async () => page.locator("#tracks").evaluate(node => node.offsetHeight === 1740), "Filtered results");
    await setSeed(page, "1".repeat(32));
    await playRow(filtered[0]);
    await checkSong(filtered[0]);
    await page.getByRole("button", { name: "Downloads", exact: true }).click();
    await background(true);
    await until(async () => nextLookups.includes(filtered[0].id), "Looked up the next song in the selected filter");
    await until(async () => audio.evaluate(element => Number.isFinite(element.duration) && !element.paused), "Track ready to finish");
    await audio.evaluate(element => { element.currentTime = element.duration - .15; });
    await checkSong(shuffleFirst(filtered, "1".repeat(32), filtered[0]));
    await background(false);

    await page.getByRole("button", { name: "Current song options", exact: true }).click();
    await page.locator("#track-dialog").getByRole("button", { name: /^Go to album/ }).click();
    await page.getByRole("heading", { name: "Paging Album", exact: true }).waitFor();
    await until(async () => page.locator("#tracks").evaluate(node => node.offsetHeight === 5800), "Album first page");
    const albumShuffle = seedBeyondFirstPage(album, album[0]);
    await setSeed(page, albumShuffle.seed);
    await playRow(album[0]);
    await checkSong(album[0]);
    await next.click();
    await checkSong(albumShuffle.track);

    await page.getByRole("button", { name: "Playlists", exact: true }).click();
    await page.getByRole("button", { name: playlistName, exact: true }).click();
    await mode.click();
    await playRow(members[0]);
    await checkSong(members[0]);
    await next.click();
    await checkSong(members[1]);
    await next.click();
    await checkSong(members[2]);
    assert.equal(await next.isDisabled(), true);

    await mode.click();
    await playRow(members[0]);
    await checkSong(members[0]);
    const heard = new Set([await playing()]);
    for (let i = 0; i < 2; i++) {
      const previous = await playing();
      await next.click();
      await until(async () => (await playing()) !== previous, "Advancing the shuffled playlist");
      heard.add(await playing());
    }
    assert.deepEqual(heard, new Set(members.map(item => item.title)));
    assert.equal(await next.isDisabled(), true);

    await audio.evaluate(element => {
      window.harborStreamStarts = [];
      element.addEventListener("playing", () => window.harborStreamStarts.push(element.currentTime));
    });
    await page.getByRole("button", { name: "Library", exact: true }).click();
    function cutMedia() {
      // A short fixture may be entirely buffered. Deliver the media error a dropped
      // connection produces while the HTTPS relay is independently unavailable.
      return audio.evaluate(element => {
        const position = element.currentTime;
        Object.defineProperty(element, "error", { configurable: true, value: { code: MediaError.MEDIA_ERR_NETWORK } });
        element.pause();
        element.addEventListener("pause", () => { delete element.error; }, { once: true });
        element.dispatchEvent(new Event("error"));
        return { position, starts: window.harborStreamStarts.length };
      });
    }
    async function interrupt(track, hidden = false) {
      await page.getByRole("searchbox", { name: "Search music" }).fill(track.title);
      await playRow(track);
      await checkSong(track);
      await until(async () => audio.evaluate(element => !element.paused && element.currentTime > 0.6),
        "Stream played before the interruption");
      await mediaAction("seekto", { seekTime: 6 });
      await until(async () => audio.evaluate(element => element.currentTime >= 6 && !element.seeking),
        "Stream reached the position to resume");
      if (hidden) await background(true);
      fs.writeFileSync(offlineMarker, "");
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      const stopped = await cutMedia();
      await until(async () => (await page.locator("#status").textContent()).includes("Stream interrupted"),
        "Harbor noticed the dropped audio transfer");
      return stopped;
    }
    async function checkResume(marker) {
      await until(async () => page.evaluate(({ starts }) => window.harborStreamStarts.length > starts, marker),
        "Audio playback resumed");
      const position = await page.evaluate(index => window.harborStreamStarts[index], marker.starts);
      assert.ok(position >= marker.position - 0.45 && position < marker.position + 1,
        "Playback restarted near the last streamed position");
    }

    phase = "network outage";
    const interrupted = await interrupt(all[84], true);
    await page.waitForResponse(response => response.request().method() === "HEAD" &&
      response.url().endsWith("/music/api/audio/" + all[84].id) && response.status() === 503);
    fs.rmSync(offlineMarker);
    await checkResume(interrupted);
    await checkSong(all[84]);
    await background(false);
    await until(async () => (await page.locator("#status").getAttribute("data-offline")) === "false", "Library reconnected");

    phase = "pause during outage";
    const paused = await interrupt(all[85]);
    await mediaAction("pause");
    fs.rmSync(offlineMarker);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await until(async () => (await page.locator("#status").getAttribute("data-offline")) === "false", "Reconnected while paused");
    assert.equal(await audio.evaluate(element => element.paused), true);
    assert.equal(await page.evaluate(() => window.harborStreamStarts.length), paused.starts);
    await page.getByRole("button", { name: "Play", exact: true }).tap();
    await checkResume(paused);
    await checkSong(all[85]);

    await page.getByRole("button", { name: "Playlists", exact: true }).click();
    await page.getByRole("button", { name: playlistName, exact: true }).click();
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await until(async () => (await page.locator("#status").textContent()).includes("ready offline"), "Playlist downloadable");
    fs.writeFileSync(offlineMarker, "");
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    phase = "switch to download during outage";
    await cutMedia();
    await until(async () => (await page.locator("#status").textContent()).includes("Stream interrupted"),
      "Prior stream was waiting to recover");
    await playRow(members[0]);
    await checkSong(members[0]);
    await page.getByRole("button", { name: "Pause", exact: true }).tap();
    await page.getByRole("button", { name: "Play", exact: true }).tap();
    await until(async () => page.locator("#audio").evaluate(audio => audio.currentSrc.startsWith("blob:") && !audio.paused),
      "Resumed the downloaded track using Play/Pause while offline");
    await next.click();
    await until(async () => (await playing()) !== members[0].title, "Shuffle from downloaded tracks");
    assert.ok(members.map(item => item.title).includes(await playing()));

    await page.getByRole("button", { name: "Library", exact: true }).click();
    await setSeed(page, "8".repeat(32));
    await playRow(members[0]);
    await checkSong(members[0]);
    await next.click();
    const offlineChoice = shuffleFirst(members, "8".repeat(32), members[0]);
    await checkSong(offlineChoice);

    fs.rmSync(offlineMarker);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await until(async () => (await page.locator("#status").getAttribute("data-offline")) === "false", "Reconnected after changing tracks");
    await checkSong(offlineChoice);
    assert.ok(await audio.evaluate(element => element.currentSrc.startsWith("blob:")));

    phase = "resume across reload";
    const bookmarkKey = "harbor-music-playback-v1";
    const waitForSync = current => until(async () => current.evaluate(() => working === null), "Catalog sync settled");
    await page.getByRole("button", { name: "Playlists", exact: true }).click();
    await page.getByRole("button", { name: playlistName, exact: true }).click();
    if (await mode.getAttribute("aria-pressed") === "true") await mode.click();
    await playRow(members[0]);
    await checkSong(members[0]);
    await until(async () => audio.evaluate(element => !element.paused && element.currentTime > 0), "Track playing before reload");
    await mediaAction("seekto", { seekTime: 5 });
    await until(async () => page.evaluate(key => {
      const bookmark = JSON.parse(localStorage.getItem(key));
      return bookmark?.position > 5.2 && bookmark.requested;
    }, bookmarkKey), "Progress and playback intent were saved periodically before closing");
    await waitForSync(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await checkSong(members[0]);
    async function ensureContinued(current, position) {
      await until(async () => current.evaluate(() => {
        const observed = window.harborPlayObserved;
        return observed.start !== null || observed.failures.length;
      }), "The player tried to resume on reopen");
      const observed = await current.evaluate(() => window.harborPlayObserved);
      assert.equal(observed.initial, true);
      assert.ok(observed.position >= position);
      if (label === "WebKit" && observed.failures.includes("NotAllowedError")) {
        await current.getByRole("button", { name: "Play", exact: true }).tap();
      }
      const media = current.locator("#audio");
      await until(async () => media.evaluate((element, saved) => !element.paused && element.currentTime >= saved, position),
        "Reopened playback continued at the saved position");
      const start = await current.evaluate(() => window.harborPlayObserved.start);
      assert.ok(start >= observed.position - 0.3 && start <= observed.position + 1,
        "The first playback after reopening started at the saved position");
    }
    await ensureContinued(page, 5);
    await next.click();
    await checkSong(members[1]);

    await until(async () => audio.evaluate(element => !element.paused && element.currentTime > 0), "Next song played");
    await mediaAction("seekto", { seekTime: 7 });
    phase = "blocked autoplay reload";
    await page.evaluate(() => sessionStorage.setItem("harbor-test-block-autoplay", "1"));
    await waitForSync(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await checkSong(members[1]);
    await until(async () => (await page.locator("#status").textContent()).includes("Tap Play to resume"),
      "Browser autoplay restriction showed the resume action");
    await page.getByRole("button", { name: "Play", exact: true }).tap();
    await until(async () => audio.evaluate(element => !element.paused && element.currentTime > 7),
      "Manual play after a blocked autoplay used the saved position");

    await mediaAction("pause");
    await mediaAction("seekto", { seekTime: 9 });
    await until(async () => page.evaluate(key => {
      const bookmark = JSON.parse(localStorage.getItem(key));
      return bookmark?.position >= 8.9 && !bookmark.requested;
    }, bookmarkKey), "Paused bookmark was saved before the page closed");
    await until(async () => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), "Offline app shell is active");
    await waitForSync(page);
    await page.close();
    fs.writeFileSync(offlineMarker, "");
    const reopened = await context.newPage();
    phase = "offline download reopen";
    captureErrors(reopened);
    await reopened.goto(phone, { waitUntil: "domcontentloaded" });
    const restoredAudio = reopened.locator("#audio");
    await until(async () => (await reopened.locator("#playing-title").textContent()) === members[1].title,
      "A fresh page reopened the previous download while offline");
    await until(async () => restoredAudio.evaluate(element =>
      element.currentSrc.startsWith("blob:") && element.paused && Math.abs(element.currentTime - 9) < 0.2),
      "Reopening preserved the paused position");
    await reopened.getByRole("button", { name: "Play", exact: true }).tap();
    await until(async () => restoredAudio.evaluate(element => !element.paused && element.currentTime > 9 && element.muted),
      "An offline download resumed from the saved position");
    fs.rmSync(offlineMarker);
    await reopened.evaluate(() => window.dispatchEvent(new Event("online")));
    await until(async () => (await reopened.locator("#status").getAttribute("data-offline")) === "false", "Library reconnected after offline reopen");
    await reopened.getByRole("searchbox", { name: "Search music" }).fill(all[84].title);
    await reopened.locator('#tracks li[data-track-id="' + all[84].id + '"] .track').tap();
    await until(async () => restoredAudio.evaluate(element => !element.paused && element.readyState >= 2 &&
      !element.currentSrc.startsWith("blob:")), "A streamed song played before closing");
    await reopened.evaluate(() => window.harborMediaActions.get("seekto")({ seekTime: 8 }));
    await until(async () => reopened.evaluate(key => {
      const saved = JSON.parse(localStorage.getItem(key));
      return saved?.position >= 7.9 && saved.requested;
    }, bookmarkKey), "Stream position was saved before closing");
    await waitForSync(reopened);
    await reopened.close();

    fs.writeFileSync(offlineMarker, "");
    const waiting = await context.newPage();
    phase = "offline stream reopen";
    captureErrors(waiting);
    await waiting.goto(phone, { waitUntil: "domcontentloaded" });
    await until(async () => (await waiting.getByRole("button", { name: "Library", exact: true }).isVisible()) &&
      (await waiting.locator("#status").getAttribute("data-offline")) === "true", "Offline reopen kept the last stream available for reconnect");
    await waitForSync(waiting);
    fs.rmSync(offlineMarker);
    await waiting.evaluate(() => window.dispatchEvent(new Event("online")));
    await until(async () => (await waiting.locator("#playing-title").textContent()) === all[84].title,
      "Reconnecting restored the saved stream");
    await ensureContinued(waiting, 8);
    assert.deepEqual(errors, []);
    console.log(label + " passed media controls, stream recovery, saved playback across reloads and reopening, and offline playback.");
  } finally {
    fs.rmSync(offlineMarker, { force: true });
    await browser.close();
  }
}

(async () => {
  await exercise(chromium, "Chromium");
  await exercise(webkit, "WebKit");
})().catch(error => { console.error(error); process.exitCode = 1; });
