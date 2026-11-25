"use strict";

const HarborSharing = (() => {
  const dialog = document.querySelector("#sharing-dialog");
  const body = document.querySelector("#sharing-body");
  const title = document.querySelector("#sharing-title");
  const notice = document.querySelector("#sharing-notice");
  let enabled = false;
  let canSend = false;
  let handled = "";
  let transfer = null;

  function element(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function action(text, callback, primary = false) {
    const node = element("button", text);
    node.type = "button";
    if (primary) node.className = "primary";
    node.addEventListener("click", async () => {
      node.disabled = true;
      notice.textContent = "";
      try {
        await callback();
      } catch (error) {
        if (error.name !== "AbortError") notice.textContent = error.message;
      } finally {
        node.disabled = false;
      }
    });
    return node;
  }

  function screen(heading, ...content) {
    title.textContent = heading;
    notice.textContent = "";
    body.replaceChildren(...content);
    if (!dialog.open) dialog.showModal();
  }

  function field(caption, options = {}) {
    const input = element("input");
    const label = element("label", caption);
    Object.assign(input, options);
    label.append(input);
    return { input, label };
  }

  function parseLink(value) {
    const link = new URL(value.trim());
    if (link.protocol !== "https:" || link.username || link.password || link.search ||
        !["/invite", "/transfer"].includes(link.pathname) || !/^#[A-Za-z0-9_-]{43}$/.test(link.hash)) {
      throw new Error("Enter a Harbor invitation or transfer link.");
    }
    return { gateway: link.origin, token: link.hash.slice(1), invite: link.pathname === "/invite" };
  }

  async function request(url, options, binary = false) {
    const response = await fetch(url, { redirect: "error", referrerPolicy: "no-referrer", cache: "no-store", ...options });
    if (response.ok && binary) return response.arrayBuffer();
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Harbor couldn’t connect.");
    return data;
  }

  function local(path, data) {
    const options = data === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json", "X-Harbor-Request": "music" },
      body: JSON.stringify(data),
    };
    return request("/music/api/sharing/" + path, options);
  }

  function remote(gateway, path, data, signal, binary = false) {
    return request(gateway + "/share/api/" + path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data), credentials: "omit", signal,
    }, binary);
  }

  function showLink(heading, link) {
    const copy = field("Link", { value: link, readOnly: true });
    screen(heading, copy.label, action("Send link", async () => {
      if (navigator.share) {
        try { await navigator.share({ title: "Harbor Music", url: link }); return; }
        catch (error) { if (error.name === "AbortError") return; }
      }
      try {
        await navigator.clipboard.writeText(link);
        notice.textContent = "Link copied.";
      } catch {
        copy.input.focus();
        copy.input.select();
        notice.textContent = "Copy the selected link.";
      }
    }, true), action("Friends", friends));
  }

  async function checkApproval(record) {
    const { token, details } = record;
    const { signature } = await local("confirm", { token });
    const result = await remote(details.gateway, "confirmation", { token, signature });
    if (result.approved) await local("confirm", { token, confirmation: result.confirmation, signature: result.signature });
    return result.approved;
  }

  async function friends() {
    const data = await local("friends");
    const name = field("Friend’s name", { maxLength: 180 });
    const pasted = field("Open an invite or transfer link", { type: "url" });
    const confirmed = element("ul");
    confirmed.className = "lists";
    for (const friend of data.friends) {
      const row = element("li");
      row.append(element("span", friend.name), action("Remove", async () => {
        if (!window.confirm("Remove this friend and close their pending shares?")) return;
        await local("revoke", { key: friend.key });
        await friends();
      }));
      confirmed.append(row);
    }
    const pending = element("div");
    pending.className = "sharing-list";
    for (const invite of data.invites) {
      if (invite.phrase) {
        const row = element("div");
        row.append(element("strong", invite.name), element("p", "Compare this phrase with your friend before approving."),
          element("code", invite.phrase), action("Approve", async () => {
            await local("approve", { token: invite.token, phrase: invite.phrase });
            await friends();
          }));
        pending.append(row);
      } else {
        pending.append(element("p", "Waiting for " + invite.name + " to open the invite."));
      }
    }
    for (const asked of data.requests) {
      pending.append(action("Check " + asked.name + "’s approval", async () => {
        if (await checkApproval(asked)) await friends();
        else notice.textContent = "Waiting for your friend to approve.";
      }));
    }
    const createInvite = canSend ? [name.label, action("Create invite", async () => {
      const result = await local("invite", { name: name.input.value.trim() });
      showLink("Friend invite ready", result.link);
    }, true)] : [];
    const instructions = canSend ? [element("p", "Use a song or playlist’s three-dot menu to share it with an approved friend.")] : [];
    screen("Friends", ...instructions, confirmed, pending, ...createInvite, pasted.label,
      action("Open link", () => openLink(parseLink(pasted.input.value))), action("Refresh", friends));
  }

  async function invite(link) {
    const info = await remote(link.gateway, "invite", { token: link.token });
    const name = field("Save friend as", { maxLength: 180 });
    screen("Friend invite", name.label, action("Accept invite", async () => {
      const result = await local("request", { ...link, sender: info.key, name: name.input.value.trim() });
      const submitted = await remote(link.gateway, "request", result);
      if (submitted.phrase !== result.phrase) throw new Error("The approval phrases don’t match. Ask for a new invite.");
      const phrase = element("code", result.phrase);
      const refresh = action("Check approval", async () => {
        if (await checkApproval({ token: link.token, details: result.details })) {
          clearLink();
          await friends();
        } else notice.textContent = "Waiting for your friend to approve.";
      }, true);
      screen("Compare this phrase", element("p", "Send these characters to your friend in your usual chat."),
        phrase, refresh);
      clearLink();
    }, true));
  }

  async function share(kind, name, tracks) {
    if (!canSend) return;
    const { friends: peers } = await local("friends");
    const options = element("select");
    for (const friend of peers) {
      const option = element("option", friend.name);
      option.value = friend.key;
      options.append(option);
    }
    if (!peers.length) {
      screen(kind === "song" ? "Share song" : "Share playlist", element("p", "Approve a friend to share music."),
        action("Friends", friends, true));
      return;
    }
    const caption = element("label", "Friend");
    caption.append(options);
    screen(kind === "song" ? "Share song" : "Share playlist", element("p", name), caption,
      action("Create link", async () => {
        notice.textContent = "Preparing your share…";
        const result = await local("share", { kind, name, tracks, key: options.value });
        showLink("Share ready", result.link);
      }, true), action("Friends", friends));
  }

  async function receive(link) {
    const data = await local("friends");
    const challenge = await remote(link.gateway, "challenge", { token: link.token, key: data.key });
    const pending = data.requests.find(request => request.details.gateway === link.gateway &&
      request.details.sender === challenge.sender);
    if (pending && !await checkApproval(pending)) throw new Error("Your friend still needs to approve this Harbor.");
    const proof = await local("proof", { ...link, ...challenge });
    const offer = await remote(link.gateway, "redeem", { ...proof, token: link.token });
    const preview = await local("preview", offer);
    screen("Add to Harbor", element("p", preview.name),
      element("p", preview.songs + (preview.songs === 1 ? " song" : " songs")),
      action("Add to Harbor", async () => {
        transfer = new AbortController();
        const { signal } = transfer;
        try {
          const ready = await local("begin", offer);
          let receipt = ready.receipt;
          if (!receipt) {
            for (let index = 0; index < offer.manifest.songs.length; index++) {
              const song = offer.manifest.songs[index];
              for (let offset = ready.offsets[index]; offset < song.size;) {
                notice.textContent = "Importing song " + (index + 1) + " of " + preview.songs + "…";
                const bytes = await remote(link.gateway, "chunk", {
                  token: link.token, lease: offer.lease, index, offset,
                }, signal, true);
                const result = await request("/music/api/sharing/part", {
                  method: "POST", signal, body: bytes, headers: { "Content-Type": "application/octet-stream",
                    "X-Harbor-Request": "music", "X-Harbor-Import": ready.id,
                    "X-Harbor-Track": String(index), "X-Harbor-Offset": String(offset) },
                });
                if (result.offset !== offset + bytes.byteLength) throw new Error("Reopen the link to resume.");
                offset = result.offset;
              }
            }
            ({ receipt } = await local("complete", { id: ready.id }));
          }
          document.dispatchEvent(new Event("harbor:imported"));
          try {
            await remote(link.gateway, "finish", { token: link.token, receipt }, signal);
          } catch {
            throw new Error("Saved in Harbor. Reopen the link to send the completion receipt.");
          }
          clearLink();
          screen("Added to Harbor", element("p", preview.name));
        } finally {
          transfer = null;
        }
      }, true));
  }

  function clearLink() {
    if (/^#(?:invite|share)=/.test(location.hash)) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  }

  function openLink(link) {
    return link.invite ? invite(link) : receive(link);
  }
  async function configure(value, sending) {
    enabled = Boolean(value);
    canSend = enabled && Boolean(sending);
    const hash = location.hash;
    if (!enabled || handled === hash || !/^#(?:invite|share)=/.test(hash)) return;
    handled = hash;
    screen("Opening Harbor link", element("p", "Checking the invitation or share…"));
    try {
      await openLink(parseLink(decodeURIComponent(hash.slice(hash.indexOf("=") + 1))));
    } catch (error) {
      notice.textContent = error.message;
    }
  }

  document.querySelector("#sharing-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    transfer?.abort();
    handled = "";
  });
  window.addEventListener("hashchange", () => void configure(enabled, canSend));
  return { configure, friends, share, get enabled() { return enabled; }, get canSend() { return canSend; } };
})();
