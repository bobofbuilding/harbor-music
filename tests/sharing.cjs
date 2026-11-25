const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { chromium, webkit, devices } = require(process.env.HARBOR_PLAYWRIGHT || "playwright");

const headers = { "X-Harbor-Request": "music" };

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function reserve() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

function relay(tls, upstream) {
  return https.createServer(tls, (request, response) => {
    const proxy = http.request({
      hostname: "127.0.0.1", port: upstream, path: request.url,
      method: request.method, headers: request.headers,
    }, result => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    proxy.on("error", () => { response.writeHead(503); response.end(); });
    request.pipe(proxy);
  });
}

async function awaitReady(url, expected) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if ((await (await fetch(url)).json()).total === expected) return; } catch { /* Server is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error("Test Harbor did not start.");
}

async function installation(base, name, tls, processes, relays) {
  const root = join(base, name);
  const music = join(root, "music");
  const imports = join(music, "Harbor Imports");
  const state = join(root, "state");
  fs.mkdirSync(imports, { recursive: true });
  const count = name === "sender" ? 2 : 1;
  execFileSync("python3", ["-B", "-", music, name, String(count)], { input: `
from pathlib import Path
import sys, wave
music, name, count = Path(sys.argv[1]), sys.argv[2], int(sys.argv[3])
for index in range(count):
    with wave.open(str(music / f"{name}-tone-{index}.wav"), "wb") as audio:
        audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        audio.writeframes(bytes([index + (2 if name == "sender" else 4)]) * 2300000)
` });
  const admin = await reserve();
  const privatePort = await reserve();
  const privateRelay = relay(tls, privatePort);
  relays.push(privateRelay);
  const privateHost = name === "receiver" ? "127.0.0.1" : "localhost";
  const privateURL = "https://" + privateHost + ":" + await listen(privateRelay);
  let transferURL;
  const env = { ...process.env, PYTHONPATH: process.cwd(), HARBOR_MUSIC_ORIGIN: privateURL, HARBOR_SHARE_IMPORT_DIR: imports };
  delete env.HARBOR_SHARE_ORIGIN;
  if (name === "sender") {
    const transferPort = await reserve();
    const transferRelay = relay(tls, transferPort);
    relays.push(transferRelay);
    transferURL = "https://localhost:" + await listen(transferRelay);
    env.HARBOR_SHARE_ORIGIN = transferURL;
    env.HARBOR_SHARE_PORT = String(transferPort);
  }
  const log = fs.openSync(join(root, "service.log"), "w");
  const child = spawn("python3", ["-B", "-m", "harbor_music", "--root", music, "--data-dir", state,
    "--admin-port", String(admin), "--music-port", String(privatePort)], {
    env,
    stdio: ["ignore", log, log],
  });
  fs.closeSync(log);
  processes.push(child);
  const adminURL = "http://127.0.0.1:" + admin;
  try { await awaitReady(adminURL + "/music/api/tracks", count); }
  catch (error) { throw new Error(error.message + "\n" + fs.readFileSync(join(root, "service.log"), "utf8")); }
  return { root, adminURL, privateURL, transferURL };
}

async function pair(page, site) {
  const code = await page.request.post(site.adminURL + "/music/api/pair-code", { headers, data: {} });
  assert.equal(code.status(), 200);
  await page.goto(site.privateURL + "/music/");
  assert.ok(await page.getByRole("button", { name: "Sharing", exact: true }).isHidden());
  await page.getByLabel("Pairing code").fill((await code.json()).code);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#tracks .track").first().waitFor();
}

const exact = (page, name) => page.getByRole("button", { name, exact: true });
const dialog = page => page.locator("#sharing-dialog");
async function openFriends(page) {
  const share = dialog(page);
  if (await share.isVisible()) await exact(share, "Close sharing").click();
  await exact(page, "Sharing").click();
  await share.getByRole("heading", { name: "Friends", exact: true }).waitFor();
}

async function exercise(engine, label, tls, base, processes, relays) {
  const sender = await installation(base, "sender", tls, processes, relays);
  const receiver = await installation(base, "receiver", tls, processes, relays);
  const browser = await engine.launch();
  try {
    const mobile = { ...devices["iPhone 13"], ignoreHTTPSErrors: true, viewport: { width: 320, height: 568 } };
    const senderPage = await browser.newPage(mobile);
    const receiverPage = await browser.newPage(mobile);
    const failures = [];
    for (const page of [senderPage, receiverPage]) page.on("pageerror", error => failures.push(error.message));
    await pair(senderPage, sender);
    await pair(receiverPage, receiver);
    assert.equal(await senderPage.locator("#title").textContent(), "Library");
    for (const page of [senderPage, receiverPage]) {
      assert.ok(await exact(page, "Sharing").evaluate(button => {
        const frame = button.getBoundingClientRect();
        return frame.height >= 44 && frame.right <= window.innerWidth &&
          document.documentElement.scrollWidth <= window.innerWidth;
      }));
    }
    const receiveSession = await (await receiverPage.request.get(receiver.privateURL + "/music/api/session")).json();
    assert.equal(receiveSession.sharing, true);
    assert.equal(receiveSession.share_sending, false);
    const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
    assert.equal((await anonymous.request.get(sender.transferURL + "/music/api/playlists")).status(), 404);
    assert.equal((await anonymous.request.get(sender.transferURL + "/")).status(), 404);
    assert.equal((await anonymous.request.get(sender.privateURL + "/music/api/sharing/friends")).status(), 401);
    const crossSiteNavigation = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
    assert.equal((await anonymous.request.get(receiver.privateURL + "/music/", { headers: crossSiteNavigation })).status(), 200);
    assert.equal((await anonymous.request.get(receiver.privateURL + "/music/api/sharing/friends",
      { headers: crossSiteNavigation })).status(), 403);

    const songs = (await (await senderPage.request.get(sender.adminURL + "/music/api/tracks?sort=title")).json()).items;
    assert.equal(songs.length, 2);
    const list = { id: "4".repeat(32), name: "Road trip", base: null, tracks: [songs[1].id, songs[0].id] };
    assert.equal((await senderPage.request.post(sender.adminURL + "/music/api/playlists", { headers, data: list })).status(), 200);

    await openFriends(senderPage);
    await dialog(senderPage).getByLabel("Friend’s name").fill("Sam");
    await exact(dialog(senderPage), "Create invite").click();
    const invitation = await dialog(senderPage).getByLabel("Link", { exact: true }).inputValue();
    await receiverPage.goto(invitation);
    await receiverPage.getByLabel("Your Harbor address").fill(receiver.privateURL + "/music/");
    await exact(receiverPage, "Open in my Harbor").click();
    await dialog(receiverPage).getByLabel("Save friend as").fill("Alex");
    await exact(dialog(receiverPage), "Accept invite").click();
    await dialog(receiverPage).getByRole("heading", { name: "Compare this phrase" }).waitFor();
    const phrase = await dialog(receiverPage).locator("code").textContent();
    await openFriends(senderPage);
    assert.equal(await dialog(senderPage).locator("code").textContent(), phrase);
    await exact(dialog(senderPage), "Approve").click();
    await dialog(senderPage).getByText("Sam", { exact: true }).waitFor();
    await exact(dialog(receiverPage), "Check approval").click();
    await dialog(receiverPage).getByText("Alex", { exact: true }).waitFor();

    await exact(dialog(senderPage), "Close sharing").click();
    await exact(senderPage, "Playlists").click();
    await exact(senderPage, "Road trip").click();
    await exact(senderPage, "Playlist options").click();
    await exact(senderPage, "Share playlist").click();
    await dialog(senderPage).getByLabel("Friend").selectOption({ label: "Sam" });
    await exact(dialog(senderPage), "Create link").click();
    const link = await dialog(senderPage).getByLabel("Link", { exact: true }).inputValue();
    assert.ok(link.startsWith(receiver.privateURL + "/music/#share="));

    const transfer = new URL(decodeURIComponent(new URL(link).hash.slice(7)));
    const value = transfer.hash.slice(1);
    const validOrigin = { Origin: receiver.privateURL };
    const peerKey = (await (await receiverPage.request.get(receiver.privateURL + "/music/api/sharing/friends")).json()).key;
    assert.equal((await anonymous.request.post(sender.transferURL + "/share/api/challenge",
      { headers: { Origin: "https://another-harbor.invalid" }, data: { token: value, key: peerKey } })).status(), 404);
    assert.equal((await anonymous.request.post(sender.transferURL + "/share/api/redeem",
      { headers: validOrigin, data: { token: value, key: peerKey } })).status(), 403);
    assert.equal((await anonymous.request.post(sender.transferURL + "/share/api/chunk",
      { headers: validOrigin, data: { token: value, lease: value, index: 0, offset: 0 } })).status(), 403);

    await exact(dialog(receiverPage), "Close sharing").click();
    await receiverPage.goto(link);
    await exact(dialog(receiverPage), "Add to Harbor").waitFor();
    assert.equal((await (await receiverPage.request.get(receiver.adminURL + "/music/api/tracks")).json()).total, 1);

    const partial = await receiverPage.request.post(sender.transferURL + "/share/api/challenge",
      { headers: validOrigin, data: { token: value, key: peerKey } });
    const challenge = await partial.json();
    const proof = await (await receiverPage.request.post(receiver.privateURL + "/music/api/sharing/proof",
      { headers, data: { ...challenge, token: value, gateway: sender.transferURL } })).json();
    const offer = await (await receiverPage.request.post(sender.transferURL + "/share/api/redeem",
      { headers: validOrigin, data: { ...proof, token: value } })).json();
    const ready = await (await receiverPage.request.post(receiver.privateURL + "/music/api/sharing/begin",
      { headers, data: offer })).json();
    assert.deepEqual(ready.offsets, [0, 0]);
    const firstChunk = await (await receiverPage.request.post(sender.transferURL + "/share/api/chunk", {
      headers: validOrigin, data: { token: value, lease: offer.lease, index: 0, offset: 0 },
    })).body();
    assert.equal(firstChunk.length, ready.chunk);
    const firstPart = await receiverPage.request.post(receiver.privateURL + "/music/api/sharing/part", {
      headers: { ...headers, "Content-Type": "application/octet-stream", "X-Harbor-Import": ready.id,
        "X-Harbor-Track": "0", "X-Harbor-Offset": "0" }, data: firstChunk,
    });
    assert.equal(firstPart.status(), 200);
    const resumed = await (await receiverPage.request.post(receiver.privateURL + "/music/api/sharing/begin",
      { headers, data: offer })).json();
    assert.deepEqual(resumed.offsets, [firstChunk.length, 0]);

    await exact(dialog(receiverPage), "Add to Harbor").click();
    await dialog(receiverPage).getByRole("heading", { name: "Added to Harbor" }).waitFor();
    const copied = (await (await receiverPage.request.get(receiver.adminURL + "/music/api/playlists")).json()).playlists;
    assert.deepEqual(copied.find(item => item.name === "Road trip").tracks.map(track => track.title), [songs[1].title, songs[0].title]);
    const receipt = await (await receiverPage.request.post(receiver.privateURL + "/music/api/sharing/complete",
      { headers, data: { id: ready.id } })).json();
    assert.equal((await receiverPage.request.post(sender.transferURL + "/share/api/finish",
      { headers: validOrigin, data: { token: value, ...receipt } })).status(), 200);
    assert.equal((await receiverPage.request.post(sender.transferURL + "/share/api/redeem",
      { headers: validOrigin, data: { ...proof, token: value } })).status(), 409);
    assert.equal((await receiverPage.request.post(sender.transferURL + "/share/api/chunk", {
      headers: validOrigin, data: { token: value, lease: offer.lease, index: 0, offset: 0 },
    })).status(), 403);
    assert.equal((await (await receiverPage.request.get(receiver.adminURL + "/music/api/tracks")).json()).total, 3);

    await exact(dialog(senderPage), "Close sharing").click();
    await exact(senderPage, "Library").click();
    await senderPage.locator("#tracks li").first().getByRole("button", { name: /^Track options/ }).click();
    await exact(senderPage.locator("#track-dialog"), "Share song").click();
    await exact(dialog(senderPage), "Create link").click();
    const songLink = await dialog(senderPage).getByLabel("Link", { exact: true }).inputValue();
    await receiverPage.goto(songLink);
    await exact(dialog(receiverPage), "Add to Harbor").click();
    await dialog(receiverPage).getByRole("heading", { name: "Added to Harbor" }).waitFor();
    assert.equal((await (await receiverPage.request.get(receiver.adminURL + "/music/api/tracks")).json()).total, 3);
    assert.deepEqual(failures, []);
    console.log(label + " passed approval, independent HTTPS origins, scoped audio transfer, resume, one import, and deduplication.");
  } finally {
    await browser.close();
  }
}

(async () => {
  const base = fs.mkdtempSync(join(tmpdir(), "harbor-sharing-test."));
  const processes = [];
  const relays = [];
  try {
    const key = join(base, "key.pem");
    const cert = join(base, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-keyout", key, "-out", cert], { stdio: "ignore" });
    const tls = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
    for (const [engine, name] of [[chromium, "Chromium"], [webkit, "WebKit"]]) {
      const folder = join(base, name);
      fs.mkdirSync(folder);
      await exercise(engine, name, tls, folder, processes, relays);
    }
  } finally {
    const stopped = processes.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else { child.once("exit", resolve); child.kill("SIGTERM"); }
    }));
    for (const relay of relays) { relay.close(); relay.closeAllConnections?.(); }
    await Promise.all(stopped);
    fs.rmSync(base, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
