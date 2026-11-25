const assert = require("node:assert/strict");
const { join } = require("node:path");
const { chromium, webkit, devices } = require(process.env.HARBOR_PLAYWRIGHT || "playwright");
const mac = "http://127.0.0.1:28765/music/api/";
const phone = "https://localhost:28767/music/";
const shots = process.env.HARBOR_MOBILE_SHOTS;

async function capture(page, name) {
  if (shots) await page.screenshot({ path: join(shots, name + ".png") });
}

async function pair(page, request) {
  const result = await request.post(mac + "pair-code", { data: {}, headers: { "X-Harbor-Request": "music" } });
  assert.equal(result.status(), 200);
  const { code } = await result.json();
  await page.getByLabel("Pairing code").fill(code);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#tracks .track").first().waitFor();
}

async function layout(page) {
  const measured = await page.evaluate(() => {
    const tracks = [...document.querySelectorAll("#tracks .track")].slice(0, 3);
    const tabs = document.querySelector(".tabs").getBoundingClientRect();
    const player = document.querySelector("#now-playing").getBoundingClientRect();
    const visible = [...document.querySelectorAll(".tabs button,.track-option,#playing-info,#favorite-player,#playback-mode")].filter(el => el.getClientRects().length);
    const previous = document.querySelector("#previous").getBoundingClientRect();
    const next = document.querySelector("#next").getBoundingClientRect();
    const playback = document.querySelector("#playback-toggle").getBoundingClientRect();
    const seek = document.querySelector("#playback-position").getBoundingClientRect();
    const middle = rect => rect.left + rect.width / 2;
    return {
      fits: document.documentElement.scrollWidth <= innerWidth + 1,
      dock: !player.height || player.bottom <= tabs.top + 1,
      space: parseFloat(getComputedStyle(document.querySelector("main")).paddingBottom) >= tabs.height + player.height,
      targets: visible.every(el => el.getBoundingClientRect().width >= 44 && el.getBoundingClientRect().height >= 44),
      skipTargets: !player.height || [previous, next].every(rect => rect.width >= 56 && rect.height >= 56),
      playbackTarget: !player.height || (playback.width >= 68 && playback.height >= 68),
      playbackCentered: !player.height || (Math.abs(middle(playback) - (middle(previous) + middle(next)) / 2) <= 1 &&
        playback.left - previous.right >= 7 && next.left - playback.right >= 7),
      seek: !player.height || (seek.width >= 120 && seek.height >= 44 && !document.querySelector("#audio").getClientRects().length),
      text: tracks.every(el => el.querySelector(".track-copy").getBoundingClientRect().width >= 115),
    };
  });
  assert.deepEqual(measured, {
    fits: true, dock: true, space: true, targets: true, skipTargets: true,
    playbackTarget: true, playbackCentered: true, seek: true, text: true,
  });
}

async function scrub(page, context, seek, label) {
  const target = await seek.boundingBox();
  const rail = await page.locator("#playback-rail").boundingBox();
  const at = fraction => rail.x + fraction * rail.width;
  const audio = page.locator("#audio");
  const position = () => audio.evaluate(element => element.currentTime);
  await seek.tap({ position: { x: at(.27) - target.x, y: 5 } });
  await page.waitForFunction(() => Math.abs(document.querySelector("#audio").currentTime - 8.1) < .3);
  const tapped = await position();

  const y = target.y + 5;
  const destination = { x: at(.62), y: target.y + target.height + 5 };
  const touch = label === "Chromium" ? await context.newCDPSession(page) : null;
  const sendTouch = (type, points = []) => touch.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  if (touch) {
    await sendTouch("touchStart", [{ x: at(.43), y }]);
    await sendTouch("touchMove", [destination]);
  } else {
    await page.mouse.move(at(.43), y);
    await page.mouse.down();
    await page.mouse.move(destination.x, destination.y, { steps: 4 });
  }
  await page.waitForFunction(() => Math.abs(document.querySelector("#playback-position").valueAsNumber - 18.6) < .3);
  assert.ok(Math.abs(await position() - tapped) < .2, "Dragging previews the new position until release");
  assert.equal(await seek.getAttribute("aria-valuetext"), "0:18 of 0:30");
  if (touch) await sendTouch("touchEnd");
  else await page.mouse.up();
  await page.waitForFunction(() => Math.abs(document.querySelector("#audio").currentTime - 18.6) < .3);

  if (touch) {
    await sendTouch("touchStart", [{ x: at(.12), y }]);
    await sendTouch("touchCancel");
    await page.waitForFunction(() => Math.abs(document.querySelector("#playback-position").valueAsNumber - 18.6) < .3);
    assert.ok(Math.abs(await position() - 18.6) < .3, "A canceled drag restores the actual position");
    await touch.detach();
  }
  await seek.press("ArrowLeft");
  await page.waitForFunction(() => document.querySelector("#audio").currentTime < 18.5);
}

async function hold(element, drift = 0) {
  const press = { pointerId: 7, pointerType: "touch", isPrimary: true, button: 0, buttons: 1, clientX: 18, clientY: 100 };
  await element.dispatchEvent("pointerdown", press);
  if (drift) await element.dispatchEvent("pointermove", { ...press, clientY: press.clientY + drift });
  await new Promise(resolve => setTimeout(resolve, 550));
  await element.dispatchEvent("pointerup", { ...press, buttons: 0 });
}

async function review(engine, label) {
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({
      ...devices["iPhone 13"], viewport: { width: 320, height: 568 }, ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    const captureHere = name => label === "WebKit" ? capture(page, name) : undefined;
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    const song = page.locator("#tracks .track").filter({ hasText: "Harbor Test Song" });
    const menu = page.locator("#track-dialog");
    const now = page.getByRole("button", { name: "Current song options", exact: true });

    await page.goto(phone);
    await page.locator("#audio").evaluate(audio => { audio.muted = true; });
    await page.getByRole("heading", { name: "Connect to Harbor" }).waitFor();
    await captureHere("pair");
    await pair(page, context.request);
    await layout(page);
    await captureHere("library");

    await hold(song, 70);
    assert.ok(await menu.isHidden());
    assert.ok(await page.locator("#now-playing").isHidden());
    await hold(song);
    await menu.getByRole("button", { name: /^Go to artist/ }).waitFor();
    await song.dispatchEvent("click", { detail: 1 });
    assert.ok(await page.locator("#now-playing").isHidden(), "A hold must not start playback");
    await captureHere("song-options");
    await menu.getByRole("button", { name: /^Go to artist/ }).click();
    await page.getByRole("heading", { name: "Tide Trio", exact: true }).waitFor();
    await song.waitFor();
    assert.deepEqual(await page.locator("#tracks .track-copy strong").allTextContents(), ["Deluxe Fixture Song", "Harbor Test Song"]);

    await song.tap();
    await now.waitFor();
    await page.waitForFunction(() => document.querySelector("#audio").currentTime > 0);
    await layout(page);
    await captureHere("player");
    const pause = page.getByRole("button", { name: "Pause", exact: true });
    const play = page.getByRole("button", { name: "Play", exact: true });
    await pause.tap({ position: { x: 12, y: 34 } });
    await play.waitFor();
    assert.equal(await page.locator("#audio").evaluate(audio => audio.paused), true);
    const seek = page.getByRole("slider", { name: "Seek within track", exact: true });
    await scrub(page, context, seek, label);
    await play.tap({ position: { x: 56, y: 34 } });
    await pause.waitFor();
    await page.waitForFunction(() => document.querySelector("#audio").currentTime > 8);
    const stream = await page.locator("#audio").evaluate(audio => audio.currentSrc);
    await hold(now);
    await menu.getByRole("button", { name: /^Go to album/ }).click();
    await page.getByRole("heading", { name: "Night Harbor", exact: true }).waitFor();
    await song.waitFor();
    assert.deepEqual(await page.locator("#tracks .track-copy strong").allTextContents(), ["Harbor Test Song"]);
    assert.ok(await page.locator("#audio").evaluate((audio, src) => !audio.paused && audio.currentSrc === src, stream));
    await captureHere("album");

    await now.tap();
    await menu.getByRole("button", { name: /^Go to album/ }).waitFor();
    await menu.getByRole("button", { name: "Close track options", exact: true }).click();
    await page.getByRole("button", { name: "All music", exact: true }).click();
    await page.locator("#tracks .track").filter({ hasText: "Colliding Artist Song" }).waitFor();
    await page.getByRole("button", { name: "Track options for Harbor Test Song", exact: true }).click();
    await menu.getByRole("button", { name: "Close track options", exact: true }).click();

    await page.getByRole("button", { name: "Filter & sort", exact: true }).click();
    await captureHere("filters");
    await page.locator("#filter-dialog").getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Playlists", exact: true }).click();
    await page.getByRole("button", { name: "New playlist", exact: true }).click();
    await captureHere("playlist");
    await page.locator("#playlist-dialog").getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Favorites", exact: true }).click();
    await page.locator("#empty").waitFor();
    await captureHere("favorites");
    await page.getByRole("button", { name: "Downloads", exact: true }).click();
    await page.getByRole("button", { name: "Download settings", exact: true }).click();
    await captureHere("downloads");
    await page.locator("#download-dialog").getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Library", exact: true }).click();
    await song.waitFor();
    for (const [width, height] of [[390, 844], [430, 932], [568, 320], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await page.waitForFunction(() => {
        const space = parseFloat(document.documentElement.style.getPropertyValue("--player-space"));
        return space === Math.ceil(document.querySelector("#now-playing").getBoundingClientRect().height);
      });
      await layout(page);
      await captureHere("layout-" + width);
    }
    await page.setViewportSize({ width: 320, height: 568 });
    await song.tap();
    const playing = page.locator("#playing-title");
    await playing.filter({ hasText: /^Harbor Test Song$/ }).waitFor();
    await page.getByRole("button", { name: "Next track", exact: true }).tap({ position: { x: 46, y: 46 } });
    await playing.filter({ hasText: /^Second Test Song$/ }).waitFor();
    await page.getByRole("button", { name: "Previous track", exact: true }).tap({ position: { x: 9, y: 46 } });
    await playing.filter({ hasText: /^Harbor Test Song$/ }).waitFor();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "125%";
      window.dispatchEvent(new Event("resize"));
    });
    await page.waitForFunction(() => document.querySelector("#tracks li")?.offsetHeight >= 72 &&
      parseFloat(document.documentElement.style.getPropertyValue("--player-space")) ===
        Math.ceil(document.querySelector("#now-playing").getBoundingClientRect().height));
    await layout(page);
    await page.setViewportSize({ width: 1024, height: 850 });
    await page.locator("#audio").waitFor();
    assert.equal(await page.locator("#audio").evaluate(audio => audio.controls), true);
    assert.equal(await page.locator("#audio").evaluate(audio => audio.muted), true);
    await page.locator("#playback-toggle").waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    console.log(label + " passed iPhone layout at five sizes, seek-strip taps, drag preview and release, keyboard seeking, track options, and desktop controls.");
  } finally {
    await browser.close();
  }
}

(async () => {
  const browsers = { chromium: [chromium, "Chromium"], webkit: [webkit, "WebKit"] };
  const requested = process.argv[2] ? [process.argv[2]] : Object.keys(browsers);
  for (const name of requested) {
    if (!Object.hasOwn(browsers, name)) throw new Error("Unknown test browser: " + name);
    await review(...browsers[name]);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
