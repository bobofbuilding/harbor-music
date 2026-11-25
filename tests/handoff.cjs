const assert = require("node:assert/strict");
const { chromium, webkit, devices } = require(process.env.HARBOR_PLAYWRIGHT || "playwright");

const desktop = "http://127.0.0.1:28765";
const music = "https://localhost:28767/music/";
const write = data => ({ data, headers: { "X-Harbor-Request": "music" } });

async function until(check, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(description);
}

async function paired(browser, options, name, gestureFallback = false) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, ...options });
  const { code } = await (await context.request.post(desktop + "/music/api/pair-code", write({}))).json();
  const authenticated = await context.request.post(music + "api/pair", write({ code, name }));
  assert.equal(authenticated.status(), 200);
  await context.addInitScript(blockFirstPlay => {
    const original = HTMLMediaElement.prototype.play;
    let block = blockFirstPlay;
    HTMLMediaElement.prototype.play = function () {
      this.muted = true;
      if (block) {
        block = false;
        return Promise.reject(new DOMException("Test browser needs a tap", "NotAllowedError"));
      }
      return original.call(this);
    };
  }, gestureFallback);
  return context;
}

async function exercise(engine, label) {
  const browser = await engine.launch();
  try {
    const mac = await paired(browser, {}, label + " Mac");
    const phone = await paired(browser, devices["iPhone 13"], label + " iPhone", true);
    const outsider = await browser.newContext({ ignoreHTTPSErrors: true });
    assert.equal((await outsider.request.get(music + "api/playback")).status(), 401);
    assert.equal((await outsider.request.post(music + "api/playback", write({}))).status(), 401);
    const errors = [];
    const macPlayer = await mac.newPage();
    macPlayer.on("pageerror", error => errors.push(error.message));
    await macPlayer.goto(music);
    const playing = page => page.locator("#playing-title").textContent();
    const play = (page, title) => page.locator("#tracks .track").filter({ hasText: title }).click();
    const state = async () => (await (await mac.request.get(music + "api/playback")).json());
    const position = (page, seconds) => page.evaluate(value => seekTo(value), seconds);
    const first = "Harbor Test Song";
    const second = "Second Test Song";
    await play(macPlayer, first);
    await until(async () => macPlayer.locator("#audio").evaluate(audio => !audio.paused && audio.currentTime > 0),
      "The Mac was playing");
    await position(macPlayer, 11);
    await until(async () => {
      const remote = await state();
      return remote.bookmark?.track.title === first && remote.bookmark.position >= 10.9 && remote.bookmark.requested;
    }, "The Mac published its playback position");
    const previous = await state();

    const phonePlayer = await phone.newPage();
    phonePlayer.on("pageerror", error => errors.push(error.message));
    await phonePlayer.goto(music);
    await until(async () => (await playing(phonePlayer)) === first, "iPhone loaded the Mac's song");
    await until(async () => (await phonePlayer.locator("#status").textContent()).includes("Tap Play to resume"),
      "A fresh iPhone page retained the position when autoplay was blocked");
    const restored = await phonePlayer.locator("#audio").evaluate(audio => audio.currentTime);
    assert.ok(restored >= 10.8 && restored < 17);
    await phonePlayer.getByRole("button", { name: "Play", exact: true }).tap();
    await until(async () => {
      const current = await state();
      return current.writer !== previous.writer && current.generation === previous.generation + 1 &&
        current.bookmark.track.title === first && current.bookmark.position >= 10.8;
    }, "The iPhone took over at the shared position");
    await until(async () => macPlayer.locator("#audio").evaluate(audio => audio.paused),
      "The Mac stopped after the iPhone took over");

    await play(phonePlayer, second);
    await until(async () => phonePlayer.locator("#audio").evaluate(audio => !audio.paused && audio.currentTime > 0),
      "iPhone played another song");
    await position(phonePlayer, 13);
    await phonePlayer.getByRole("button", { name: "Pause", exact: true }).tap();
    await until(async () => {
      const { bookmark } = await state();
      return bookmark?.track.title === second && bookmark.position >= 12.9 && !bookmark.requested;
    }, "The iPhone shared the new song and intentional pause");
    const latest = await state();
    const stale = await mac.request.post(music + "api/playback", write({
      writer: previous.writer, generation: previous.generation, sequence: 100000, claim: true,
      track: previous.bookmark.track.id, position: 0, requested: true,
    }));
    assert.equal(stale.status(), 409);
    const replay = await phone.request.post(music + "api/playback", write({
      writer: latest.writer, generation: latest.generation, sequence: 1, claim: false,
      track: latest.bookmark.track.id, position: 0, requested: true,
    }));
    assert.equal(replay.status(), 200);
    assert.deepEqual(await state(), latest);
    await macPlayer.evaluate(() => window.dispatchEvent(new Event("focus")));
    await until(async () => (await playing(macPlayer)) === second &&
      await macPlayer.locator("#audio").evaluate(audio => audio.paused && audio.currentTime >= 12.9),
    "Returning to the Mac showed the iPhone's song, position, and pause");
    await macPlayer.locator("#audio").evaluate(audio => audio.play());
    await until(async () => {
      const current = await state();
      return current.writer !== latest.writer && current.bookmark.track.title === second &&
        current.bookmark.requested && current.bookmark.position >= 12.9;
    }, "The Mac resumed from the iPhone's saved place");
    assert.deepEqual(errors, []);
    console.log(label + " passed paired-device playback handoff in both directions, paused position, and rejection of stale writes.");
  } finally {
    await browser.close();
  }
}

(async () => {
  await exercise(chromium, "Chromium");
  await exercise(webkit, "WebKit");
})().catch(error => { console.error(error); process.exitCode = 1; });
