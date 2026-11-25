const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { chromium, webkit, devices } = require(process.env.HARBOR_PLAYWRIGHT || "playwright");

const root = process.argv[2];
const library = join(root, "library");
const desktop = "http://127.0.0.1:28765/music/api/";
const mobile = "https://localhost:28767/music/";
const song = "Harbor Test Song";
const write = data => ({ data, headers: { "X-Harbor-Request": "music" } });

async function until(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  throw new Error(description);
}

function launch(command, args) {
  const child = spawn(command, args, {
    env: { ...process.env, PYTHONPATH: process.cwd() },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const service = { child, log: "" };
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8").on("data", chunk => { service.log = (service.log + chunk).slice(-2000); });
  }
  child.on("error", error => { service.log = error.message; });
  service.closed = new Promise(resolve => child.once("close", resolve));
  return service;
}

async function crash(service) {
  if (!service) return;
  if (service.child.exitCode === null && service.child.signalCode === null) service.child.kill("SIGKILL");
  await service.closed;
}

async function paired(browser, options, name) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, ...options });
  const code = await context.request.post(desktop + "pair-code", write({}));
  assert.equal(code.status(), 200);
  const reply = await context.request.post(mobile + "api/pair", write({ code: (await code.json()).code, name }));
  assert.equal(reply.status(), 200);
  await context.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      this.muted = true;
      return play.call(this);
    };
    // The two isolated browser contexts represent two foreground devices.
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    window.harborTestDocument = crypto.randomUUID();
    window.harborOnlineEvents = 0;
    window.addEventListener("online", () => { window.harborOnlineEvents++; });
  });
  const page = await context.newPage();
  await page.goto(mobile);
  await page.locator("#tracks .track").first().waitFor();
  return page;
}

const action = (page, name) => page.getByRole("button", { name, exact: true });
const offline = async page => (await page.locator("#status").getAttribute("data-offline")) === "true";
const documentId = page => page.evaluate(() => window.harborTestDocument);
const seekAt = (page, position) => page.locator("#audio").evaluate((audio, time) =>
  audio.paused && Math.abs(audio.currentTime - time) < 0.35, position);

async function addPlaylist(page, name) {
  await action(page, "Playlists").click();
  await action(page, "New playlist").click();
  const form = page.locator("#playlist-form");
  await form.getByLabel("Playlist name").fill(name);
  await form.getByLabel("Keep this playlist").selectOption("synced");
  await form.getByRole("button", { name: "Save playlist" }).click();
}

async function exercise(engine, label) {
  const nas = () => launch("python3", ["-B", "-m", "harbor_music", "--root", join(library, "music"),
    "--data-dir", join(root, label), "--admin-port", "28765", "--music-port", "28766"]);
  const relay = () => launch(process.execPath, ["tests/https-relay.cjs", root]);
  const ready = async (browser, url) => {
    const check = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await until(async () => {
        try { return (await check.request.get(url, { timeout: 1000 })).ok(); }
        catch { return false; }
      }, "Fixture did not start at " + url);
    } finally {
      await check.close();
    }
  };
  const browser = await engine.launch();
  let host;
  let proxy;
  try {
    host = nas();
    proxy = relay();
    await ready(browser, mobile + "api/session");
    const macPage = await paired(browser, {}, label + " Mac");
    const phonePage = await paired(browser, devices["iPhone 13"], label + " iPhone");
    const original = await Promise.all([documentId(macPage), documentId(phonePage)]);
    assert.ok(original.every(Boolean));
    const get = async endpoint => (await (await macPage.request.get(desktop + endpoint)).json());
    const listHas = async name => (await get("playlists")).playlists.some(list => list.name === name);
    const waitOffline = description => until(async () => await offline(macPage) && await offline(phonePage), description, 35000);
    const waitOnline = description => until(async () => !await offline(macPage) && !await offline(phonePage), description, 25000);
    const detectLoss = async () => {
      await Promise.all([action(macPage, "Favorites").click(), action(phonePage, "Favorites").click()]);
    };

    await macPage.locator("#tracks .track").filter({ hasText: song }).click();
    await until(async () => macPage.locator("#audio").evaluate(audio => !audio.paused && audio.currentTime > 0),
      "Mac started playing");
    await macPage.evaluate(() => { seekTo(9); pausePlayback(); });
    await until(async () => {
      const { bookmark } = await get("playback");
      return bookmark?.track.title === song && Math.abs(bookmark.position - 9) < 0.35 && !bookmark.requested;
    }, "Playback position was saved before the connection failed");
    const checkpoint = await get("playback");

    await crash(proxy);
    await waitOffline("Devices did not detect the dropped HTTPS connection");
    await action(macPage, "Favorite current track").click();
    await addPlaylist(macPage, "Queued through link loss");
    await action(phonePage, "Playlists").click();
    assert.equal(await listHas("Queued through link loss"), false);
    proxy = relay();
    await waitOnline("Devices did not reconnect after the HTTPS listener restarted");
    await until(() => listHas("Queued through link loss"), "Queued playlist did not sync after link restart");
    await until(async () => (await get("tracks")).items.some(item => item.title === song && item.favorite),
      "Queued favorite did not sync after link restart");
    await action(phonePage, "Queued through link loss").waitFor({ timeout: 36000 });
    await until(() => seekAt(phonePage, 9), "iPhone did not receive the Mac's paused playback position");

    await crash(host);
    await detectLoss();
    await waitOffline("Devices did not detect the Harbor service crash");
    await addPlaylist(phonePage, "Queued through host crash");
    host = nas();
    await waitOnline("Devices did not reconnect after the Harbor service restarted");
    await until(() => listHas("Queued through host crash"), "The iPhone's queued playlist did not sync after host restart");
    const saved = await get("playback");
    assert.equal(saved.generation, checkpoint.generation);
    assert.equal(saved.writer, checkpoint.writer);
    assert.equal(saved.bookmark.track.id, checkpoint.bookmark.track.id);
    assert.ok(Math.abs(saved.bookmark.position - 9) < 0.35 && !saved.bookmark.requested);
    assert.deepEqual(await Promise.all([documentId(macPage), documentId(phonePage)]), original);
    for (const page of [macPage, phonePage]) {
      assert.equal(await page.evaluate(() => window.harborOnlineEvents), 0);
    }

    await action(phonePage, "Play").tap();
    await until(async () => {
      const current = await get("playback");
      return current.writer !== saved.writer && current.bookmark.track.id === saved.bookmark.track.id &&
        current.bookmark.position >= 8.7 && current.bookmark.requested;
    }, "iPhone did not take over at the saved position after the crash");
    console.log(label + " recovered after an HTTPS relay restart and a Harbor process crash. Playlist, Favorite, pairing, and playback state survived.");
  } catch (error) {
    if (host?.log) console.error(host.log);
    if (proxy?.log) console.error(proxy.log);
    throw error;
  } finally {
    try { await browser.close(); }
    finally { await Promise.all([crash(host), crash(proxy)]); }
  }
}

(async () => {
  await exercise(chromium, "Chromium");
  await exercise(webkit, "WebKit");
})().catch(error => { console.error(error); process.exitCode = 1; });
