"use strict";

const input = document.querySelector("#address");
const message = document.querySelector("#message");
const form = document.querySelector("#open-harbor");
try { input.value = localStorage.getItem("my-harbor-address") || ""; } catch { /* Optional convenience. */ }

if (!/^#[A-Za-z0-9_-]{43}$/.test(location.hash)) {
  form.hidden = true;
  message.textContent = "Ask your friend for a new invite.";
}

form.addEventListener("submit", event => {
  event.preventDefault();
  try {
    const library = new URL(input.value.trim());
    if (library.protocol !== "https:" || library.username || library.password ||
        !["/", "/music", "/music/"].includes(library.pathname) || library.search || library.hash ||
        library.origin === location.origin) throw new Error();
    try { localStorage.setItem("my-harbor-address", library.origin); } catch { /* Optional convenience. */ }
    location.assign(library.origin + "/music/#invite=" + encodeURIComponent(location.href));
  } catch {
    message.textContent = "Enter the HTTPS address you use to open your own Harbor.";
  }
});
