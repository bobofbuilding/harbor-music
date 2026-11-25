"use strict";

const $ = selector => document.querySelector(selector);
const apiBase = "/music/api/";
const downloadsCache = "harbor-music-downloads";
const playbackKey = "harbor-music-playback-v1";
const audioURL = id => apiBase + "audio/" + id;
const audio = $("#audio");
const player = $("#now-playing");
const sharingShortcut = $("#open-sharing");
const playbackToggle = $("#playback-toggle");
const playbackPosition = $("#playback-position");
const playbackRail = $("#playback-rail");
const mediaSession = navigator.mediaSession;
const mediaActions = new Map();
const trackDialog = $("#track-dialog");
const trackList = $("#tracks");
const pageMarker = $("#track-page");
const naturalRowHeight = () => Math.max(58, Math.ceil(parseFloat(getComputedStyle(document.documentElement).fontSize) * 3.625));
let rowHeight = naturalRowHeight();
const rowBuffer = 12;
const pageBuffer = 360;
trackList.style.setProperty("--track-height", rowHeight + "px");
const renderedRows = new Map();
let displayedTracks = [];
let listFrame = 0;
const state = {
  known: false, owner: false, playlists: {}, edits: {}, favorites: {}, library: [],
  offlineSources: null, offlineOmissions: {}, nextMode: "order",
};
let online = false;
let view = "library";
let selectedList = null;
let collection = null;
let menuTrack = null;
let menuPlaylist = null;
let tracks = [];
let downloads = {};
let total = 0;
let query = "";
let filters = { sort: "title", genre: "", artist: "", album: "" };
let genreOptions = [];
let downloadingBatch = false;
let checkingDownloads = false;
let downloadCheckPending = false;
let downloadCleanupPending = false;
let offlineStorageFull = false;
let lastDownloadFavorites = null;
const automaticAttempts = new Map();
const queuedDownloads = new Map();
const alphabet = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const sortLabels = { title: "Song title A–Z", "title-desc": "Song title Z–A", artist: "Artist", genre: "Genre", album: "Album", playlist: "Playlist order" };
const missingGenre = "@harbor-untagged";
let requestGeneration = 0;
let pageRequest = null;
let nextOffset = 0;
let pageError = false;
let searchTimer;
const metadataAttempts = new Map();
let refreshingMetadata = false;
let working = null;
let connectionReady = false;
let pageActive = true;
let connectionTimer;
let retryDelay = 1000;
let activeTrack = null;
let playback = null;
let objectURL = null;
let streamPlayback = null;
let playbackRequested = false;
let pendingStartPosition = null;
let pendingBookmark = readPlaybackBookmark();
let bookmarkSource = pendingBookmark?.source;
let lastBookmarkWrite = 0;
const playbackWriter = uid();
let sharedPlayback = null;
let resumeSharedOnReturn = false;
let claimPlayback = false;
let playbackSequence = 0;
let queuedPlayback = null;
let publishingPlayback = false;
let lastSharedWrite = 0;
let playbackGeneration = 0;
let pauseRevision = 0;
let seekPointer = null;
let addTrack = null;
let editing = null;
let deleting = null;
let notice = "";
let noticeTimer;
const downloading = new Set();

const database = new Promise((resolve, reject) => {
  const request = indexedDB.open("harbor-music", 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("state");
    request.result.createObjectStore("downloads");
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function storage(store, method, ...args) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const read = method === "get" || method === "getAll";
    const transaction = db.transaction(store, read ? "readonly" : "readwrite");
    const request = transaction.objectStore(store)[method](...args);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error || request.error);
  });
}

function save() {
  return storage("state", "put", structuredClone(state), "music");
}

async function api(path, body, signal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const options = { cache: "no-store", signal: controller.signal };
    if (body !== undefined) {
      Object.assign(options, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Harbor-Request": "music" },
        body: JSON.stringify(body),
        keepalive: path === "playback",
      });
    }
    const response = await fetch(apiBase + path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(data.error || "Harbor is unavailable."), { status: response.status, data });
    }
    return data;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

function uid() {
  return crypto.randomUUID().replaceAll("-", "");
}

function button(label, handler, className = "") {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  if (className) element.className = className;
  element.addEventListener("click", handler);
  return element;
}

function status(message) {
  if (message) {
    clearTimeout(noticeTimer);
    notice = message;
    noticeTimer = setTimeout(() => { notice = ""; status(); }, 7000);
  }
  const pending = Object.keys(state.edits).length + Object.keys(state.favorites).length;
  const streamInterrupted = streamPlayback?.interrupted && playbackRequested;
  const connection = online ? "Connected to media host" : "Offline · Reconnecting automatically";
  $("#status").textContent = notice || (streamInterrupted ? "Stream interrupted · Reconnecting" :
    state.known ? connection + (pending ? " · Changes waiting to sync" : "") :
    online ? "Connect to Harbor to get started." : connection);
  $("#status").dataset.offline = String(!online);
  $("#status").dataset.quiet = String(online && !notice && !pending && !streamInterrupted);
}

function showApp(allowed) {
  $("#app").hidden = !allowed;
  $("#pair-view").hidden = allowed;
  $("#devices").hidden = !(allowed && state.owner);
  if (sharingShortcut) sharingShortcut.hidden = !(allowed && HarborSharing.enabled);
}

function mergedTracks() {
  const items = new Map(Object.values(downloads).map(track => [track.id, track]));
  for (const playlist of Object.values(state.playlists)) {
    for (const track of playlist.tracks) items.set(track.id, track);
  }
  for (const track of state.library) items.set(track.id, track);
  return [...items.values()];
}

function favorite(track) {
  return state.favorites[track.id]?.value ?? Boolean(track.favorite);
}

function currentSelection() {
  return { view, filters: { ...filters }, collection, query, playlistId: selectedList };
}

function selectionParams({ view, filters, collection, query }) {
  const params = new URLSearchParams({
    q: query, sort: filters.sort, artist: filters.artist, album: filters.album,
  });
  if (collection?.artist) params.set("group_artist", collection.artist);
  if (collection?.album) params.set("group_album", collection.album);
  if (filters.genre === missingGenre) params.set("genre_missing", "1");
  else if (filters.genre) params.set("genre", filters.genre);
  if (view === "favorites") params.set("favorite", "1");
  return params;
}

function matchingTracks(items, selection = currentSelection()) {
  const { filters, collection, query } = selection;
  const fold = text => (text || "").toLowerCase();
  const needle = fold(query);
  const genre = fold(filters.genre);
  const artist = fold(filters.artist);
  const album = fold(filters.album);
  const results = items.filter(track =>
    (!collection?.artist || fold(track.artist).trim() === fold(collection.artist)) &&
    (!collection?.album || fold(track.album).trim() === fold(collection.album)) &&
    (!genre || (filters.genre === missingGenre ? !track.genre : fold(track.genre) === genre)) &&
    fold(track.artist).includes(artist) && fold(track.album).includes(album) &&
    fold([track.title, track.artist, track.album, track.genre].join(" ")).includes(needle),
  );
  if (filters.sort === "playlist") return results;
  const field = filters.sort === "title-desc" ? "title" : filters.sort;
  const compare = (a, b) => alphabet.compare(a || "", b || "");
  const sortField = (a, b) => Number(!a) - Number(!b) || compare(a, b);
  return results.sort((a, b) => {
    const primary = field === "title" ?
      compare(a.title, b.title) * (filters.sort === "title-desc" ? -1 : 1) :
      sortField(a[field], b[field]);
    if (primary) return primary;
    if (field === "artist" || field === "album") {
      const secondary = field === "artist" ? "album" : "artist";
      return compare(a[secondary], b[secondary]) || (a.disc || 0) - (b.disc || 0) ||
        (a.track || 0) - (b.track || 0) || compare(a.title, b.title) || compare(a.id, b.id);
    }
    return compare(a.title, b.title) || compare(a.artist, b.artist) || compare(a.id, b.id);
  });
}

function isBrowseView() {
  return view === "library" || view === "favorites";
}

function visibleTracks() {
  if (view === "playlists") return matchingTracks(state.playlists[selectedList]?.tracks || []);
  if (view === "downloads") return matchingTracks(Object.values(downloads));
  if (!online) {
    return matchingTracks(mergedTracks().filter(track => view !== "favorites" || favorite(track)));
  }
  if (view === "favorites") {
    const shown = tracks.filter(favorite);
    const ids = new Set(shown.map(track => track.id));
    const pending = matchingTracks(mergedTracks().filter(item => state.favorites[item.id]?.value && !ids.has(item.id)));
    return [...pending, ...shown];
  }
  return tracks;
}

function defaultSort() {
  if (view === "playlists" && selectedList) return "playlist";
  return collection?.kind === "album" ? "album" : "title";
}

function resetFilters() {
  clearTimeout(searchTimer);
  searchTimer = null;
  filters = { sort: defaultSort(), genre: "", artist: "", album: "" };
  query = "";
  $("#search").value = "";
}

function playerFavorite() {
  const heart = $("#favorite-player");
  const active = Boolean(activeTrack && favorite(activeTrack));
  heart.textContent = active ? "♥" : "♡";
  heart.setAttribute("aria-pressed", String(active));
}

function songDetails(track) {
  return [track.artist, track.album].filter(Boolean).join(" · ") || "Unknown artist";
}

function icon(label, text, action, pressed) {
  const element = button(text, action, "track-option");
  element.title = label;
  element.setAttribute("aria-label", label);
  if (pressed !== undefined) element.setAttribute("aria-pressed", String(pressed));
  return element;
}

function addHoldAction(element, getTrack) {
  let timer = 0;
  let press = null;
  let suppressClickUntil = 0;
  const stop = () => {
    clearTimeout(timer);
    press = null;
  };
  const open = () => {
    const track = getTrack();
    if (!track || !element.isConnected || trackDialog.open) return;
    suppressClickUntil = Date.now() + 1000;
    openTrackOptions(track);
  };
  element.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0) return;
    stop();
    suppressClickUntil = 0;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY };
    timer = setTimeout(open, 480);
  });
  element.addEventListener("pointermove", event => {
    if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) stop();
  });
  for (const event of ["pointerup", "pointercancel", "pointerleave", "lostpointercapture"]) {
    element.addEventListener(event, stop);
  }
  element.addEventListener("contextmenu", event => {
    event.preventDefault();
    // Touch uses the movement-aware timer so a scrolling finger never opens a menu.
    if (event.button !== 2 && event.pointerType !== "mouse") return;
    stop();
    open();
  });
  element.addEventListener("click", event => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClickUntil = 0;
    }
  }, true);
}

function removeFromPlaylist(track, id) {
  const playlist = state.playlists[id];
  if (!playlist) return;
  rememberLegacyDownload(track.id, id);
  void updatePlaylist({ ...playlist, tracks: playlist.tracks.filter(item => item.id !== track.id) });
}

function openTrackOptions(track) {
  if (trackDialog.open) return;
  menuTrack = track;
  menuPlaylist = view === "playlists" && state.playlists[selectedList]?.tracks.some(item => item.id === track.id) ?
    selectedList : null;
  $("#track-dialog-title").textContent = track.title;
  $("#track-dialog-detail").textContent = songDetails(track);
  $("#track-menu-artist").textContent = track.artist || "";
  $("#track-menu-album").textContent = track.album || "";
  $('[data-track-action="artist"]').hidden = !track.artist?.trim();
  $('[data-track-action="album"]').hidden = !track.album?.trim();
  $('[data-track-action="remove"]').hidden = !menuPlaylist;
  $('[data-track-action="share"]').hidden = !HarborSharing.canSend;
  const download = $('[data-track-action="download"]');
  download.textContent = downloads[track.id] ? "Remove download" : "Download track";
  download.disabled = downloading.has(track.id);
  trackDialog.showModal();
}

function openCollection(track, kind) {
  const artist = (track.artist || "").trim();
  const album = kind === "album" ? (track.album || "").trim() : "";
  const title = kind === "artist" ? artist : album;
  if (!title) return;
  void selectView("library", { kind, title, artist, album });
  $("#title").focus({ preventScroll: true });
}

function renderTrack(track, index) {
  const row = document.createElement("li");
  row.dataset.trackId = track.id;
  row.style.top = index * rowHeight + "px";
  row.setAttribute("aria-posinset", String(index + 1));
  const selection = currentSelection();
  const play = button("", () => startPlayback(displayedTracks, index, selection), "track hold-target");
  addHoldAction(play, () => track);
  const mark = document.createElement("span");
  mark.className = "track-icon";
  mark.textContent = track.id === activeTrack?.id ? "▶" : "♪";
  mark.setAttribute("aria-hidden", "true");
  const copy = document.createElement("span");
  copy.className = "track-copy";
  const title = document.createElement("strong");
  title.textContent = track.title;
  const detail = document.createElement("small");
  detail.textContent = filters.sort === "genre"
    ? [track.genre || "Genre unavailable", track.artist, track.album].filter(Boolean).join(" · ")
    : songDetails(track);
  copy.append(title, detail);
  play.append(mark, copy);
  const downloaded = Boolean(downloads[track.id]);
  const pending = downloading.has(track.id);
  const download = icon(
    downloaded ? "Remove download" : pending ? "Downloading" : "Download track",
    downloaded ? "✓" : pending ? "…" : "↓",
    () => downloaded ? removeDownload(track.id) : downloadTracks([track]),
    downloaded,
  );
  download.disabled = pending;
  download.classList.add("wide-track-action");
  const add = icon("Add to playlist", "＋", () => openAdd(track));
  add.classList.add("wide-track-action");
  row.append(play, icon("Favorite", favorite(track) ? "♥" : "♡", () => markFavorite(track), favorite(track)), add, download);
  if (view === "playlists" && selectedList) {
    const id = selectedList;
    const remove = icon("Remove from playlist", "−", () => removeFromPlaylist(track, id));
    remove.classList.add("wide-track-action");
    row.append(remove);
  }
  const options = icon("Track options for " + track.title, "⋯", () => openTrackOptions(track));
  options.setAttribute("aria-haspopup", "dialog");
  row.append(options);
  return row;
}

function canLoadMore() {
  return !$("#app").hidden && online && isBrowseView() && nextOffset < total;
}

function updatePageMarker() {
  pageMarker.hidden = !(canLoadMore() || pageRequest || pageError);
  $("#page-status").textContent = pageError ? "Couldn’t load more tracks." : pageRequest ? "Loading tracks…" : "";
  $("#more").hidden = !pageError;
}

function scheduleListFrame() {
  if (listFrame) return;
  listFrame = requestAnimationFrame(() => {
    listFrame = 0;
    renderTrackWindow();
    if (!document.hidden && canLoadMore() && !pageRequest && !pageError && !searchTimer &&
        pageMarker.getBoundingClientRect().top <= window.innerHeight + pageBuffer) {
      void loadTracks(true);
    }
  });
}

function renderTrackWindow(refresh = false) {
  if ($("#app").hidden) return;
  const top = trackList.getBoundingClientRect().top;
  const length = displayedTracks.length;
  const first = Math.min(length, Math.max(0, Math.floor(-top / rowHeight) - rowBuffer));
  const end = Math.min(length, Math.max(first, Math.ceil((window.innerHeight - top) / rowHeight) + rowBuffer));
  for (const [index, row] of renderedRows) {
    if (refresh || index < first || index >= end || row.dataset.trackId !== displayedTracks[index]?.id) {
      row.remove();
      renderedRows.delete(index);
    }
  }
  trackList.style.height = length * rowHeight + "px";
  const count = isBrowseView() && online ? Math.max(total, length) : length;
  let position = trackList.firstElementChild;
  for (let index = first; index < end; index++) {
    let row = renderedRows.get(index);
    if (!row) {
      row = renderTrack(displayedTracks[index], index);
      renderedRows.set(index, row);
      trackList.insertBefore(row, position);
    }
    row.setAttribute("aria-setsize", String(count));
    position = row.nextElementSibling;
  }
  if (view === "downloads" || (view === "playlists" && state.playlists[selectedList]?.scope === "local")) {
    void refreshCachedMetadata(displayedTracks.slice(first, end));
  }
}

function resetTrackPages() {
  pageRequest?.abort();
  pageRequest = null;
  requestGeneration++;
  nextOffset = 0;
  total = 0;
  tracks = [];
  pageError = false;
}

function scrollToStart() {
  window.scrollTo({ top: 0, behavior: "auto" });
}

function render(refreshTracks = true) {
  const playlist = state.playlists[selectedList];
  if (selectedList && !playlist) {
    selectedList = null;
    resetFilters();
  }
  const listMenu = view === "playlists" && !playlist;
  const visible = visibleTracks();
  $("#title").textContent = collection?.title || (playlist && view === "playlists" ? playlist.name : {
    library: "Library", playlists: "Playlists", favorites: "Favorites", downloads: "Downloads",
  }[view]);
  const detail = $("#collection-detail");
  detail.textContent = collection?.kind === "album" ? collection.artist : "";
  detail.hidden = !detail.textContent;
  $("#browse-tools").hidden = listMenu;
  const summary = [
    filters.genre === missingGenre ? "Genre unavailable" : filters.genre,
    filters.artist && "Artist · " + filters.artist,
    filters.album && "Album · " + filters.album,
    filters.sort !== defaultSort() ? sortLabels[filters.sort] : "",
  ].filter(Boolean);
  $("#filter-summary").hidden = !summary.length;
  $("#filter-summary").textContent = summary.join(" / ");
  $("#lists").hidden = !listMenu;
  updatePageMarker();
  playerFavorite();
  updatePlaybackControls();
  $("#actions").replaceChildren();
  const actions = $("#actions");
  if (collection) {
    actions.append(button("All music", () => void selectView("library")));
  } else if (listMenu) {
    actions.append(button("New playlist", () => openCreate(), "primary"));
  } else if (view === "playlists" && playlist) {
    const edit = HarborSharing.canSend
      ? button("⋯", () => $("#playlist-options").showModal())
      : button("Edit", () => openCreate(playlist));
    if (HarborSharing.canSend) edit.setAttribute("aria-label", "Playlist options");
    actions.append(
      button("All playlists", () => selectView("playlists")),
      edit,
      button("Download", () => downloadTracks(playlist.tracks), "primary"),
    );
  } else if (view === "favorites" || view === "downloads") {
    actions.append(button("Download settings", () => void openDownloadSettings()));
  }
  $("#lists").replaceChildren();
  if (listMenu) {
    const playlists = Object.values(state.playlists).sort((a, b) => a.name.localeCompare(b.name));
    for (const item of playlists) {
      const row = document.createElement("li");
      const title = button(item.name, () => {
        selectedList = item.id;
        resetFilters();
        scrollToStart();
        render();
      }, "list-link");
      const details = document.createElement("span");
      details.className = "list-meta";
      details.textContent = [item.scope === "local" ? "This device" : "Synced", item.tracks.length].join(" · ");
      row.append(title, details);
      $("#lists").append(row);
    }
  }
  displayedTracks = visible;
  renderTrackWindow(refreshTracks);
  scheduleListFrame();
  const hasItems = listMenu ? $("#lists").childElementCount > 0 : visible.length > 0;
  const empty = $("#empty");
  empty.hidden = hasItems || Boolean(pageRequest) || pageError;
  empty.textContent = {
    library: online ? "No songs found." : "No songs are saved here. Download music when Harbor reconnects.",
    playlists: listMenu ? "Create a playlist or add a song from the library." : "Add songs from Library, Favorites, or Downloads.",
    favorites: "Tap the heart in the player or beside a song to save it here.",
    downloads: "Download a song or playlist to listen here offline.",
  }[view];
  if (!hasItems && (query || summary.length) && !listMenu) empty.textContent = "No tracks match these filters.";
}

async function selectView(next, destination = null) {
  view = next;
  collection = destination;
  selectedList = null;
  resetFilters();
  resetTrackPages();
  scrollToStart();
  document.querySelectorAll("[data-view]").forEach(element => {
    if (element.dataset.view === view) element.setAttribute("aria-current", "page");
    else element.removeAttribute("aria-current");
  });
  render();
  if (isBrowseView()) await loadTracks();
  if (view === "playlists") void sync();
}

async function loadTracks(append = false) {
  if (!isBrowseView()) return;
  if (append) {
    if (!canLoadMore() || pageRequest) return;
  } else {
    resetTrackPages();
  }
  if (!online) { render(); return; }

  const generation = requestGeneration;
  const controller = new AbortController();
  pageRequest = controller;
  pageError = false;
  if (append) updatePageMarker();
  else render();
  try {
    const params = selectionParams(currentSelection());
    params.set("offset", String(nextOffset));
    const listing = await api("tracks?" + params, undefined, controller.signal);
    if (generation !== requestGeneration) return;
    total = listing.total;
    nextOffset = listing.items.length ? nextOffset + listing.items.length : total;

    // The catalog may change between pages. Advance by the server row count
    // and show each track once even if it moved into a different page.
    const ids = new Set(tracks.map(track => track.id));
    const additions = listing.items.filter(track => !ids.has(track.id));
    tracks = tracks.concat(additions);
    const cache = new Map(listing.items.map(track => [track.id, track]));
    for (const track of state.library) if (!cache.has(track.id)) cache.set(track.id, track);
    state.library = [...cache.values()].slice(0, 500);
    await save().catch(() => {});
  } catch (error) {
    if (generation !== requestGeneration) return;
    if (error.status === 401) showApp(false);
    else if (append) {
      pageError = true;
      if (!error.status || error.status >= 500) void sync();
    } else if (!error.status || error.status >= 500) {
      online = false;
      if (!working) scheduleConnectionCheck();
    }
  } finally {
    if (generation === requestGeneration) {
      pageRequest = null;
      const scrollPosition = window.scrollY;
      render(!append);
      if (append && window.scrollY > scrollPosition + rowHeight) {
        window.scrollTo({ top: scrollPosition, behavior: "auto" });
      }
      status();
    }
  }
}

function fillGenres(selected) {
  const localGenres = mergedTracks().map(track => track.genre).filter(Boolean);
  const allGenres = new Map([...localGenres, ...genreOptions].map(value => [value.toLowerCase(), value]));
  if (selected && selected !== missingGenre) allGenres.set(selected.toLowerCase(), selected);
  const options = [...allGenres.values()].sort(alphabet.compare);
  const select = $("#filter-form").elements.genre;
  select.replaceChildren(new Option("Any genre", ""), new Option("Genre unavailable", missingGenre),
    ...options.map(value => new Option(value, value)));
  select.value = selected;
}

function loadFilterFields(values) {
  const fields = $("#filter-form").elements;
  fields.sort.options[0].hidden = !(view === "playlists" && selectedList);
  fields.sort.value = values.sort;
  fields.artist.value = values.artist;
  fields.album.value = values.album;
  fillGenres(values.genre);
}

async function openFilters() {
  loadFilterFields(filters);
  const dialog = $("#filter-dialog");
  dialog.showModal();
  if (!online) return;
  try {
    const status = await api("genres");
    if (!dialog.open) return;
    genreOptions = status.genres;
    fillGenres($("#filter-form").elements.genre.value);
  } catch { /* Previously seen genres are still available. */ }
}

async function refreshCachedMetadata(items) {
  if (!online || refreshingMetadata) return;
  const now = Date.now();
  const pending = [...new Set(items.filter(item =>
    item.genre == null && now - (metadataAttempts.get(item.id) || 0) > 60000,
  ).map(item => item.id))].slice(0, 100);
  if (!pending.length) return;
  refreshingMetadata = true;
  for (const id of pending) metadataAttempts.set(id, now);
  try {
    const response = await api("metadata", { ids: pending });
    const fresh = new Map(response.items.filter(item => item.genre != null).map(track => [track.id, track]));
    if (!fresh.size) return;
    const update = track => fresh.get(track.id) || track;
    state.library = state.library.map(update);
    for (const playlist of Object.values(state.playlists)) playlist.tracks = playlist.tracks.map(update);
    for (const [id, track] of fresh) {
      if (!downloads[id]) continue;
      const updated = { ...track, offlineFrom: downloads[id].offlineFrom };
      downloads[id] = updated;
      await storage("downloads", "put", updated, id);
    }
    await save();
    render();
  } catch { /* The cached list remains usable when the server is unreachable. */ }
  finally {
    refreshingMetadata = false;
    scheduleListFrame();
  }
}

function openDownloadSettings() {
  const dialog = $("#download-dialog");
  const list = $("#download-choices");
  const picks = new Set(state.offlineSources);
  const playlists = Object.values(state.playlists).sort((a, b) => alphabet.compare(a.name, b.name));
  if (!state.offlineSources && view === "favorites") picks.add("favorites");
  const options = [{ id: "favorites", name: "Favorites" }, ...playlists];
  list.replaceChildren(...options.map(item => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "source";
    input.value = item.id;
    input.checked = picks.has(item.id);
    label.append(input, document.createTextNode(item.name));
    return label;
  }));
  dialog.showModal();
}

async function downloadSelected(sources) {
  for (const source of state.offlineSources || []) {
    if (sources.includes(source)) continue;
    const previousTracks = source === "favorites" ? Object.values(downloads).filter(isDownloadFavorite) :
      state.playlists[source]?.tracks || [];
    for (const track of previousTracks) rememberLegacyDownload(track.id, source);
  }
  state.offlineSources = sources;
  for (const [id, omitted] of Object.entries(state.offlineOmissions)) {
    const current = omitted.filter(source => sources.includes(source));
    if (current.length) state.offlineOmissions[id] = current;
    else delete state.offlineOmissions[id];
  }
  try {
    await save();
    automaticAttempts.clear();
    offlineStorageFull = false;
    status(sources.length && !playbackOnline() ? "Downloads will start when Harbor reconnects." : "Download settings saved.");
    void checkSelectedDownloads();
    await working;
    void sync();
  } catch {
    status("Couldn’t save your download settings.");
  }
}

async function checkSelectedDownloads(cleanup = false) {
  downloadCheckPending = true;
  downloadCleanupPending ||= cleanup;
  if (checkingDownloads || downloadingBatch || !playbackOnline()) return;
  checkingDownloads = true;
  downloadCheckPending = false;
  const reconcile = downloadCleanupPending;
  downloadCleanupPending = false;
  try {
    const selection = state.offlineSources;
    const selected = new Set(selection);
    const chosen = new Map();
    const include = (track, source) => {
      if (!chosen.has(track.id)) chosen.set(track.id, { track, sources: new Set() });
      chosen.get(track.id).sources.add(source);
    };
    if (selected.has("favorites")) {
      let offset = 0;
      let total;
      do {
        const page = await api("tracks?favorite=1&sort=title&offset=" + offset);
        total = page.total;
        for (const track of page.items) if (favorite(track)) include(track, "favorites");
        offset += page.items.length;
        if (!page.items.length) break;
      } while (offset < total && state.offlineSources?.includes("favorites"));
      for (const track of mergedTracks()) {
        if (state.favorites[track.id]?.value) include(track, "favorites");
      }
      lastDownloadFavorites = new Set(chosen.keys());
    } else {
      lastDownloadFavorites = null;
    }
    for (const source of selected) {
      for (const track of state.playlists[source]?.tracks || []) include(track, source);
    }

    let omissionsChanged = false;
    for (const [id, omitted] of Object.entries(state.offlineOmissions)) {
      const current = omitted.filter(source => state.offlineSources?.includes(source) &&
        (!selected.has(source) || chosen.get(id)?.sources.has(source)));
      if (current.length === omitted.length) continue;
      if (current.length) state.offlineOmissions[id] = current;
      else delete state.offlineOmissions[id];
      omissionsChanged = true;
    }
    if (omissionsChanged) await save();

    if (reconcile) {
      if (downloadingBatch) {
        downloadCheckPending = true;
        downloadCleanupPending = true;
      } else {
        const ready = () => playbackOnline() && !downloadCheckPending && !downloadingBatch &&
          state.offlineSources === selection && !Object.keys(state.edits).length &&
          (!selected.has("favorites") || !Object.keys(state.favorites).length);
        await reconcileDownloadMembership(chosen, selected, ready);
      }
    }
    if (!offlineStorageFull) {
      const sourcesForDownload = id => {
        if ((automaticAttempts.get(id) || 0) >= 3) return null;
        const sources = [...chosen.get(id).sources].filter(source => state.offlineSources?.includes(source));
        return sources.some(source => !state.offlineOmissions[id]?.includes(source)) ? sources : null;
      };
      await downloadTracks([...chosen.values()].map(item => item.track), sourcesForDownload);
    }
  } catch {
    // The saved selections will be checked again after the next successful sync.
  } finally {
    checkingDownloads = false;
    if (downloadCheckPending && !downloadingBatch && playbackOnline()) void checkSelectedDownloads();
  }
}

async function reconcileDownloadMembership(chosen, selected, ready) {
  const obsolete = [];
  for (const id of Object.keys(downloads)) {
    if (!ready()) return;
    const track = downloads[id];
    if (!track) continue;
    const previous = track.offlineFrom;
    const current = [...(chosen.get(track.id)?.sources || [])];
    if (previous?.length === 0) continue;
    if (!current.length) {
      if (isAutomaticDownload(track)) obsolete.push(track.id);
      continue;
    }
    if (previous?.length === current.length && previous.every(source => current.includes(source))) continue;
    const updated = { ...track, offlineFrom: current };
    downloads[track.id] = updated;
    try {
      await storage("downloads", "put", updated, track.id);
    } catch (error) {
      if (downloads[track.id] === updated) downloads[track.id] = track;
      throw error;
    }
  }

  if (!obsolete.length || !ready()) return;
  const cache = await caches.open(downloadsCache);
  let removed = false;
  try {
    for (let offset = 0; offset < obsolete.length && ready(); offset += 100) {
      // Confirm the track still exists and check Favorites again before deleting a copy.
      const { items } = await api("metadata", { ids: obsolete.slice(offset, offset + 100) });
      for (const track of items) {
        if (!ready()) return;
        if (selected.has("favorites") && favorite(track)) continue;
        if (isAutomaticDownload(downloads[track.id])) {
          removed = await eraseDownload(track.id, cache) || removed;
        }
      }
    }
  } finally {
    if (removed) {
      if (offlineStorageFull) automaticAttempts.clear();
      offlineStorageFull = false;
      render();
    }
  }
}

function openCreate(playlist = null) {
  editing = playlist?.id || null;
  $("#playlist-title").textContent = editing ? "Edit playlist" : "New playlist";
  const form = $("#playlist-form");
  form.elements.name.value = playlist?.name || "";
  form.elements.scope.value = playlist?.scope || "synced";
  form.elements.scope.disabled = Boolean(playlist?.revision || (playlist && state.edits[playlist.id]));
  $("#delete-playlist").hidden = !playlist;
  $("#playlist-dialog").showModal();
  form.elements.name.focus();
}

function openAdd(track) {
  addTrack = track;
  $("#add-track-title").textContent = track.title;
  const playlists = Object.values(state.playlists).sort((a, b) => a.name.localeCompare(b.name));
  $("#add-choices").replaceChildren(...playlists.map(playlist => {
    const exists = playlist.tracks.some(item => item.id === track.id);
    const choice = button(playlist.name + (exists ? " ✓" : ""), () => {
      $("#add-dialog").close();
      addTrack = null;
      const current = state.playlists[playlist.id];
      if (!current) status("This playlist is no longer available.");
      else if (!current.tracks.some(item => item.id === track.id)) {
        void updatePlaylist({ ...current, tracks: [...current.tracks, track] });
      }
    });
    choice.disabled = exists;
    return choice;
  }));
  $("#add-dialog").showModal();
}

async function updatePlaylist(playlist) {
  state.playlists[playlist.id] = playlist;
  if (playlist.scope === "synced") {
    state.edits[playlist.id] = {
      id: playlist.id,
      name: playlist.name,
      base: playlist.revision || null,
      tracks: playlist.tracks.map(item => item.id),
      operation: uid(),
    };
  } else {
    delete state.edits[playlist.id];
  }
  try {
    await save();
    render();
    status(playlist.scope === "local" ? "Saved on this device." : online ? "Playlist saved." : "Saved offline. Syncs when Harbor reconnects.");
    if (state.offlineSources?.includes(playlist.id)) void checkSelectedDownloads();
    void sync();
  } catch {
    status("Couldn’t save the playlist on this device.");
  }
}

async function removePlaylist(playlist) {
  const { id, scope } = playlist;
  const current = state.playlists[id];
  if (!current) { status("This playlist is no longer available."); return; }
  const previousEdit = state.edits[id];
  const previousSources = state.offlineSources;
  const shared = scope === "synced";
  if (previousSources?.includes(id)) {
    for (const track of current.tracks) rememberLegacyDownload(track.id, id);
  }
  if (shared) {
    state.edits[id] = { id, base: playlist.revision || null, remove: true, operation: uid() };
  } else {
    state.offlineSources = previousSources?.filter(source => source !== id) ?? null;
  }
  delete state.playlists[id];
  try {
    await save();
  } catch {
    state.playlists[id] = current;
    if (previousEdit) state.edits[id] = previousEdit;
    else delete state.edits[id];
    state.offlineSources = previousSources;
    status("Couldn’t delete the playlist on this device.");
    return;
  }
  render();
  status(!shared ? "Playlist deleted from this device." : online ?
    "Deleting playlist…" : "Playlist will be deleted across devices when Harbor reconnects.");
  if (shared || previousSources?.includes(id)) {
    await working;
    void sync();
  }
}

function replaceShared(playlists) {
  const shared = new Set(playlists.map(playlist => playlist.id));
  let changed = false;
  for (const playlist of Object.values(state.playlists)) {
    if (playlist.scope === "synced" && !shared.has(playlist.id) && !state.edits[playlist.id]) {
      if (state.offlineSources?.includes(playlist.id)) {
        for (const track of playlist.tracks) rememberLegacyDownload(track.id, playlist.id);
      }
      delete state.playlists[playlist.id];
      changed = true;
    }
  }
  for (const playlist of playlists) {
    if (state.edits[playlist.id]) continue;
    const previous = state.playlists[playlist.id];
    changed ||= previous?.revision !== playlist.revision || (selectedList === playlist.id &&
      JSON.stringify(previous?.tracks) !== JSON.stringify(playlist.tracks));
    state.playlists[playlist.id] = { ...playlist, scope: "synced" };
  }
  state.offlineSources = state.offlineSources?.filter(id =>
    id === "favorites" || state.playlists[id] || state.edits[id]?.remove,
  ) ?? null;
  return changed;
}

function scheduleConnectionCheck() {
  clearTimeout(connectionTimer);
  if (!connectionReady || !pageActive || document.hidden) return;
  const delay = online ? 25000 : retryDelay;
  retryDelay = online ? 1000 : Math.min(retryDelay * 2, 15000);
  connectionTimer = setTimeout(() => { void sync(); }, delay);
}

function sync() {
  if (!connectionReady || !pageActive || working) return working;
  clearTimeout(connectionTimer);
  working = syncWithHarbor().finally(() => {
    working = null;
    scheduleConnectionCheck();
  });
  return working;
}

async function syncWithHarbor() {
  let changedFavorites = false;
  let changedPlaylists = false;
  let sharingChanged = false;
  let reconnected = false;
  try {
    const session = await api("session");
    if (typeof session.paired !== "boolean" || typeof session.owner !== "boolean") {
      throw new Error("Harbor’s response is unavailable.");
    }
    reconnected = !online || $("#app").hidden;
    online = true;
    state.owner = session.owner;
    state.known ||= session.paired;
    if (HarborSharing.enabled !== Boolean(session.sharing) ||
        HarborSharing.canSend !== Boolean(session.share_sending)) {
      sharingChanged = true;
      void HarborSharing.configure(session.sharing, session.share_sending);
    }
    showApp(session.paired);
    if (!session.paired) {
      status();
      return;
    }
    await refreshSharedPlayback();
    restorePlaybackBookmark();
    for (const edit of Object.values(state.edits)) {
      try {
        const remote = edit.remove ? await api("playlists/delete", { id: edit.id, base: edit.base }) :
          await api("playlists", edit);
        const pending = state.edits[edit.id];
        if (pending?.operation === edit.operation) {
          if (edit.remove) status("Playlist deleted.");
          else state.playlists[edit.id] = { ...remote, scope: "synced" };
          delete state.edits[edit.id];
          changedPlaylists = true;
        } else if (pending && !edit.remove) {
          pending.base = remote.revision;
          if (state.playlists[edit.id]) state.playlists[edit.id].revision = remote.revision;
        }
      } catch (error) {
        if (error.status !== 409) throw error;
        if (state.edits[edit.id]?.operation !== edit.operation) continue;
        changedPlaylists = true;
        const local = state.playlists[edit.id];
        if (!edit.remove && local?.scope === "synced") {
          const id = uid();
          const name = local.name.slice(0, 160) + " (my edits)";
          state.playlists[id] = { ...local, id, name, revision: null, scope: "local" };
          if (selectedList === edit.id) selectedList = id;
        }
        delete state.edits[edit.id];
        if (error.data.current) state.playlists[edit.id] = { ...error.data.current, scope: "synced" };
        else if (local?.scope === "synced") delete state.playlists[edit.id];
        status(edit.remove ? error.message : error.message + " Your edits were saved on this device.");
      }
      await save();
    }
    for (const [id, edit] of Object.entries(state.favorites)) {
      const remote = await api("favorite", { id, favorite: edit.value }).catch(error => {
        if (error.status === 404) return null;
        throw error;
      });
      if (state.favorites[id]?.operation === edit.operation) delete state.favorites[id];
      if (remote) {
        changedFavorites = true;
        const updateTrack = track => track.id === id ? { ...track, favorite: remote.favorite } : track;
        state.library = state.library.map(updateTrack);
        tracks = tracks.map(updateTrack);
        Object.values(state.playlists).forEach(playlist => { playlist.tracks = playlist.tracks.map(updateTrack); });
        if (activeTrack?.id === id) activeTrack = updateTrack(activeTrack);
        if (downloads[id]) {
          downloads[id] = updateTrack(downloads[id]);
          await storage("downloads", "put", downloads[id], id);
        }
      }
      await save();
    }
    const shared = await api("playlists");
    changedPlaylists = replaceShared(shared.playlists) || changedPlaylists;
    await save();
    if (reconnected) automaticAttempts.clear();
    if (state.offlineSources || Object.keys(state.offlineOmissions).length) void checkSelectedDownloads(true);
    if ((reconnected && isBrowseView()) || (changedFavorites && view === "favorites")) await loadTracks();
  } catch (error) {
    if (error.status === 401) showApp(false);
    else if (!error.status || error.status >= 500) online = false;
    else status(error.message);
  }
  if (changedFavorites || sharingChanged || reconnected || !online || (view === "playlists" && changedPlaylists)) render();
  status();
}

async function markFavorite(track) {
  const value = !favorite(track);
  if (!value) rememberLegacyDownload(track.id, "favorites");
  state.favorites[track.id] = { value, operation: uid() };
  if (!state.library.some(item => item.id === track.id)) state.library.unshift(track);
  try {
    await save();
    render();
    status(value ? "Saved to Favorites." : "Removed from Favorites.");
    if (state.offlineSources?.includes("favorites")) void checkSelectedDownloads();
    await sync();
  } catch {
    status("Couldn’t save this change.");
  }
}

function isAutomaticDownload(track) {
  // Older releases used null for auto-downloads detached from unchecked or deleted lists.
  return track?.offlineFrom === null || Boolean(track?.offlineFrom?.length);
}

function isDownloadFavorite(track) {
  return state.favorites[track.id]?.value ?? (lastDownloadFavorites?.has(track.id) ?? Boolean(track.favorite));
}

function rememberLegacyDownload(id, source) {
  const track = downloads[id];
  if (!track || track.offlineFrom !== undefined || !state.offlineSources?.includes(source)) return;
  const updated = { ...track, offlineFrom: [source] };
  downloads[id] = updated;
  void storage("downloads", "put", updated, id).catch(() => {});
}

async function downloadTracks(list, automatic = null) {
  if (downloadingBatch) {
    if (automatic) downloadCheckPending = true;
    else if (list.length) {
      for (const track of list) if (!downloads[track.id]) queuedDownloads.set(track.id, track);
      if (queuedDownloads.size) status("Added to the download queue.");
    }
    return;
  }
  if (!list.length) { if (!automatic) status("There are no tracks to download."); return; }
  const pending = list.filter(track => !downloads[track.id] && !downloading.has(track.id) && (!automatic || automatic(track.id)));
  if (!pending.length) { if (!automatic) status("These tracks are already available offline."); return; }
  if (!playbackOnline()) { if (!automatic) status("Reconnect to Harbor to download these tracks."); return; }

  downloadingBatch = true;
  let failures = 0;
  let saved = 0;
  let clearedOmissions = false;
  try {
    const cache = await caches.open(downloadsCache);
    for (const track of pending) {
      if (automatic && (downloadCheckPending || queuedDownloads.size)) { downloadCheckPending = true; break; }
      const offlineFrom = automatic ? automatic(track.id) : [];
      if (!offlineFrom || downloading.has(track.id)) continue;
      if (!playbackOnline()) break;
      downloading.add(track.id);
      if (pending.length === 1) render();
      if (!automatic) status(pending.length === 1 ? "Downloading " + track.title + "…" :
        "Downloading " + (saved + failures + 1) + " of " + pending.length + " tracks…");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      try {
        const url = audioURL(track.id);
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (response.status >= 500 || [401, 403].includes(response.status)) {
          if (automatic) automaticAttempts.set(track.id, (automaticAttempts.get(track.id) || 0) + 1);
          break;
        }
        if (response.status !== 200) throw new Error("Track unavailable");
        const blob = await response.blob();
        if (!blob.size || Number(response.headers.get("Content-Length")) !== blob.size) throw new Error("Incomplete download");
        await cache.put(url, new Response(blob, { headers: { "Content-Type": blob.type } }));
        const downloaded = { ...track, offlineFrom };
        try {
          await storage("downloads", "put", downloaded, track.id);
        } catch (error) {
          await cache.delete(url);
          throw error;
        }
        downloads[track.id] = downloaded;
        automaticAttempts.delete(track.id);
        if (!automatic && state.offlineOmissions[track.id]) {
          delete state.offlineOmissions[track.id];
          clearedOmissions = true;
        }
        saved++;
        if (automatic && view === "downloads") render();
      } catch (error) {
        failures++;
        if (automatic) automaticAttempts.set(track.id, (automaticAttempts.get(track.id) || 0) + 1);
        if (error.name === "QuotaExceededError") {
          offlineStorageFull = true;
          if (automatic) status("Free up space on this device to resume automatic downloads.");
        }
        if (!navigator.onLine || error.name === "QuotaExceededError" || error.name === "AbortError") break;
      } finally {
        clearTimeout(timeout);
        downloading.delete(track.id);
      }
    }
  } catch {
    // The browser can reject offline storage before the first track starts.
  } finally {
    if (clearedOmissions) await save().catch(() => {});
    downloadingBatch = false;
    render();
    if (!automatic) status(saved === pending.length ? "Downloaded tracks are ready offline." :
      "Saved " + saved + " of " + pending.length + " tracks. Check your connection and storage, then try again.");
    if (queuedDownloads.size) {
      const queued = [...queuedDownloads.values()];
      queuedDownloads.clear();
      void downloadTracks(queued);
    } else if (downloadCheckPending && !checkingDownloads) void checkSelectedDownloads();
  }
}

async function eraseDownload(id, cache) {
  const track = downloads[id];
  if (!track || downloading.has(id)) return false;
  downloading.add(id);
  delete downloads[id];
  try {
    await cache.delete(audioURL(id));
    await storage("downloads", "delete", id);
    return true;
  } catch (error) {
    downloads[id] = track;
    throw error;
  } finally {
    downloading.delete(id);
  }
}

async function removeDownload(id) {
  try {
    const track = downloads[id];
    if (!track) return;
    const cache = await caches.open(downloadsCache);
    if (!await eraseDownload(id, cache)) return;
    const omissions = state.offlineSources?.filter(source => source === "favorites" ? isDownloadFavorite(track) :
      state.playlists[source]?.tracks.some(item => item.id === id));
    if (omissions?.length) {
      state.offlineOmissions[id] = omissions;
      await save();
    }
    const resume = offlineStorageFull;
    offlineStorageFull = false;
    if (resume) { automaticAttempts.clear(); void checkSelectedDownloads(); }
    render();
    status("Download removed from this device.");
  } catch {
    status("Couldn’t remove the download.");
  }
}

function playbackOnline() {
  return online;
}

function historyPosition(session, direction) {
  for (let i = session.index + direction; i >= 0 && i < session.history.length; i += direction) {
    if (playbackOnline() || downloads[session.history[i].id]) return i;
  }
  return -1;
}

function localPlaybackTracks(session, offline = !playbackOnline()) {
  if (!session.remote) return session.tracks;
  if (!offline) return session.tracks;
  const saved = Object.values(downloads).filter(track => session.selection.view !== "favorites" || favorite(track));
  const current = session.history[session.index];
  if (!saved.some(item => item.id === current.id)) saved.push(current);
  return matchingTracks(saved, session.selection);
}

function updatePlaybackControls() {
  const mode = $("#playback-mode");
  const shuffled = state.nextMode === "shuffle";
  mode.textContent = shuffled ? "Shuffle" : "In order";
  mode.setAttribute("aria-pressed", String(shuffled));
  mode.title = shuffled ? "Switch to playing in order" : "Shuffle this selection";
  if (!playback) return;
  $("#previous").disabled = historyPosition(playback, -1) < 0;
  const forward = historyPosition(playback, 1) >= 0;
  const current = playback.history[playback.index];
  const canStream = playbackOnline();
  const valid = track => canStream || Boolean(downloads[track.id]);
  let more = playback.remote && canStream && !playback.exhausted;
  if ((!playback.remote || !canStream) && !playback.offlineExhausted) {
    const list = localPlaybackTracks(playback);
    const index = list.findIndex(track => track.id === current.id);
    more = list.some((track, i) => valid(track) &&
      (shuffled ? !playback.played.has(track.id) : i > index));
  }
  $("#next").disabled = Boolean(playback.request) || !(forward || more);
  setMediaAction("previoustrack", $("#previous").disabled ? null : previousTrack);
  setMediaAction("nexttrack", $("#next").disabled ? null : nextTrack);
}

function setMediaAction(action, handler) {
  if (!mediaSession || mediaActions.get(action) === handler) return;
  mediaActions.set(action, handler);
  try { mediaSession.setActionHandler(action, handler); }
  catch { /* Some browsers expose only a subset of the actions. */ }
}

function discardUpcoming() {
  if (!playback?.upcoming) return;
  playback.upcoming.controller.abort();
  playback.upcoming = null;
}

function prepareShuffle(session, track) {
  session.seed = uid();
  session.anchor = track.id;
  session.played = new Set([track.id]);
  session.ranks = new Map();
}

function changeMode() {
  state.nextMode = state.nextMode === "shuffle" ? "order" : "shuffle";
  if (playback) {
    discardUpcoming();
    playback.request?.abort();
    playback.request = null;
    playback.exhausted = false;
    playback.offlineExhausted = false;
    playback.history.length = playback.index + 1;
    prepareShuffle(playback, playback.history[playback.index]);
  }
  prepareBackgroundTrack();
  updatePlaybackControls();
  void save().catch(() => {});
}

function startPlayback(list, index, selection = currentSelection()) {
  const track = list[index];
  if (!track) return;
  if (!playbackOnline() && !downloads[track.id]) {
    status("Download this track before listening offline.");
    return;
  }
  pendingBookmark = null;
  selectPlayback(track, list, selection);
  void playTrack(track);
}

function selectPlayback(track, list, selection) {
  discardUpcoming();
  playback?.request?.abort();
  const remote = selection.view === "library" || selection.view === "favorites";
  playback = {
    selection, remote, tracks: remote ? [] : list.slice(),
    history: [track], index: 0, request: null, upcoming: null, exhausted: false, offlineExhausted: false,
  };
  prepareShuffle(playback, track);
}

function readPlaybackBookmark() {
  try {
    const entry = JSON.parse(localStorage.getItem(playbackKey));
    const selection = entry?.selection;
    if (/^[a-f0-9]{40}$/.test(entry?.track?.id) && typeof entry.track.title === "string" &&
        Number.isFinite(entry.position) && entry.position >= 0 && typeof entry.requested === "boolean" &&
        ["library", "favorites", "playlists", "downloads"].includes(selection?.view) &&
        typeof selection.query === "string" && selection.filters && typeof selection.filters.sort === "string") {
      return entry;
    }
  } catch { /* Playback also works when browser storage is unavailable. */ }
  return null;
}

function savePlaybackBookmark(immediate = false, claim = false) {
  if (!pageActive || !activeTrack || playback?.history[playback.index]?.id !== activeTrack.id) return;
  const now = performance.now();
  if (!immediate && now - lastBookmarkWrite < 1000) return;
  const streamPosition = streamPlayback?.interrupted || streamPlayback?.restoring ? streamPlayback.position : null;
  const position = audio.ended ? 0 : pendingStartPosition ?? streamPosition ?? audio.currentTime;
  if (!Number.isFinite(position) || position < 0) return;
  lastBookmarkWrite = now;
  const bookmark = {
    track: activeTrack, position, requested: playbackRequested && !audio.ended,
    selection: playback.selection, source: bookmarkSource,
  };
  try {
    localStorage.setItem(playbackKey, JSON.stringify(bookmark));
  } catch { /* Storage limits must never stop playback. */ }
  queueSharedPlayback(bookmark, immediate, claim);
}

function restorePlaybackBookmark(replace = false) {
  const entry = pendingBookmark;
  if (!entry || (!replace && activeTrack) || $("#app").hidden || (!online && !downloads[entry.track.id])) return;
  pendingBookmark = null;
  const { selection } = entry;
  const track = downloads[entry.track.id] || mergedTracks().find(item => item.id === entry.track.id) || entry.track;
  const source = selection.view === "playlists" ? state.playlists[selection.playlistId]?.tracks :
    selection.view === "downloads" ? Object.values(downloads) : [];
  const list = matchingTracks(source || [], selection);
  selectPlayback(track, list.some(item => item.id === track.id) ? list : [track], selection);
  void playTrack(track, { position: entry.position, requested: entry.requested });
}

function followSharedPlayback({ bookmark }, requested) {
  if (!bookmark) return;
  const playlist = state.playlists[bookmark.playlist];
  pendingBookmark = {
    ...bookmark,
    requested,
    selection: {
      view: playlist?.scope === "synced" ? "playlists" : "library",
      playlistId: playlist?.id ?? null, collection: null, query: "",
      filters: { sort: playlist?.scope === "synced" ? "playlist" : "title", genre: "", artist: "", album: "" },
    },
  };
  bookmarkSource = null;
  restorePlaybackBookmark(true);
}

async function refreshSharedPlayback() {
  if (publishingPlayback) return;
  let received;
  try { received = await api("playback"); }
  catch { return; }
  if (!Number.isSafeInteger(received.generation) || publishingPlayback ||
      received.generation < (sharedPlayback?.generation ?? 0)) return;
  const previous = sharedPlayback;
  const resume = resumeSharedOnReturn;
  resumeSharedOnReturn = false;
  sharedPlayback = received;
  if (!received.bookmark || received.writer === playbackWriter) return;
  if (previous?.writer === playbackWriter) {
    receivePlaybackHandoff(received);
    return;
  }
  const sameSource = bookmarkSource?.writer === received.writer && bookmarkSource.generation === received.generation;
  if (!activeTrack && !sameSource) {
    followSharedPlayback(received, received.bookmark.requested);
  } else if (!playbackRequested && !sameSource &&
      (resume || received.generation !== previous?.generation ||
        received.bookmark.position !== previous?.bookmark?.position ||
        received.bookmark.track.id !== previous?.bookmark?.track.id)) {
    followSharedPlayback(received, resume && received.bookmark.requested);
  }
}

function queueSharedPlayback(bookmark, immediate, claim) {
  if (!online || !sharedPlayback || (!claim && sharedPlayback.writer !== playbackWriter)) return;
  const now = performance.now();
  if (!immediate && now - lastSharedWrite < 3000) return;
  const playlist = state.playlists[bookmark.selection.playlistId];
  lastSharedWrite = now;
  queuedPlayback = {
    writer: playbackWriter, generation: sharedPlayback.generation, sequence: ++playbackSequence, claim,
    track: bookmark.track.id, position: bookmark.position, requested: bookmark.requested,
    playlist: playlist?.scope === "synced" ? playlist.id : null,
  };
  void publishSharedPlayback();
}

function receivePlaybackHandoff(current) {
  const wasPlaying = playbackRequested;
  queuedPlayback = null;
  pausePlayback();
  followSharedPlayback(current, false);
  if (wasPlaying) status("Playback moved to another device.");
}

async function publishSharedPlayback() {
  if (publishingPlayback || !queuedPlayback) return;
  const request = queuedPlayback;
  queuedPlayback = null;
  publishingPlayback = true;
  try {
    sharedPlayback = await api("playback", request);
    bookmarkSource = { writer: playbackWriter, generation: sharedPlayback.generation };
    if (request.claim && (activeTrack?.id !== request.track || playbackRequested !== request.requested)) {
      savePlaybackBookmark(true);
    }
  } catch (error) {
    if (error.status === 409 && error.data.current) {
      sharedPlayback = error.data.current;
      if (sharedPlayback.writer !== playbackWriter) receivePlaybackHandoff(sharedPlayback);
    }
  } finally {
    publishingPlayback = false;
    void publishSharedPlayback();
  }
}

function previousTrack() {
  if (!playback) return;
  const previous = historyPosition(playback, -1);
  if (previous < 0) return;
  discardUpcoming();
  playback.request?.abort();
  playback.request = null;
  playback.index = previous;
  void playTrack(playback.history[previous]);
}

async function downloadedShuffle(session, tracks, current) {
  // Match the server's seeded order so reconnecting does not restart the shuffle.
  const { seed, ranks, anchor } = session;
  const encode = new TextEncoder();
  function rank(id) {
    if (!ranks.has(id)) {
      ranks.set(id, crypto.subtle.digest("SHA-256", encode.encode(seed + id)).then(
        hash => Array.from(new Uint8Array(hash), part => part.toString(16).padStart(2, "0")).join(""),
      ));
    }
    return ranks.get(id);
  }
  const comparison = current.id === anchor ? "" : await rank(current.id);
  const values = await Promise.all(tracks.map(track => rank(track.id)));
  let choice;
  let firstRank;
  for (let index = 0; index < tracks.length; index++) {
    const track = tracks[index];
    const value = values[index];
    const follows = value > comparison || (value === comparison && track.id > current.id);
    if (follows && (!choice || value < firstRank || (value === firstRank && track.id < choice.id))) {
      choice = track;
      firstRank = value;
    }
  }
  return choice;
}

function localNext(session, current, shuffle, offline) {
  const list = localPlaybackTracks(session, offline);
  if (shuffle) {
    const eligible = list.filter(track => (!offline || downloads[track.id]) && !session.played.has(track.id));
    if (session.remote) return downloadedShuffle(session, eligible, current);
    return eligible[Math.floor(Math.random() * eligible.length)];
  }
  const from = list.findIndex(track => track.id === current.id);
  return list.find((track, index) => index > from && (!offline || downloads[track.id]));
}

function lookupNextTrack(session, current, shuffle, signal) {
  const params = selectionParams(session.selection);
  params.set("after", current.id);
  if (shuffle) {
    params.set("anchor", session.anchor);
    params.set("shuffle", session.seed);
  }
  return api("next-track?" + params, undefined, signal);
}

function prepareBackgroundTrack() {
  const session = playback;
  if (!document.hidden || !session?.remote || !playbackOnline() || audio.paused || audio.ended ||
      session.request || session.upcoming || session.exhausted || historyPosition(session, 1) >= 0) return;
  const current = session.history[session.index];
  if (activeTrack?.id !== current.id) return;
  const controller = new AbortController();
  session.upcoming = {
    after: current.id, controller,
    result: lookupNextTrack(session, current, state.nextMode === "shuffle", controller.signal).catch(() => null),
  };
}

async function nextTrack() {
  const session = playback;
  if (!session || session.request) return;
  const forward = historyPosition(session, 1);
  if (forward >= 0) {
    discardUpcoming();
    session.index = forward;
    void playTrack(session.history[forward]);
    return;
  }
  const current = session.history[session.index];
  const shuffle = state.nextMode === "shuffle";
  const upcoming = playbackOnline() && session.upcoming?.after === current.id ? session.upcoming : null;
  if (upcoming) session.upcoming = null;
  else discardUpcoming();
  const controller = upcoming?.controller || new AbortController();
  session.request = controller;
  updatePlaybackControls();
  try {
    let track;
    if (session.remote && playbackOnline()) {
      if (session.exhausted) return;
      try {
        let result = upcoming && await upcoming.result;
        if (controller.signal.aborted) return;
        if (!result) result = await lookupNextTrack(session, current, shuffle, controller.signal);
        if (controller.signal.aborted) return;
        track = result.track;
        session.exhausted = !track;
      } catch (error) {
        if (controller.signal.aborted) return;
        track = await localNext(session, current, shuffle, true);
        if (!track) status("Harbor is unreachable. Reconnect to continue this selection.");
      }
    } else {
      track = await localNext(session, current, shuffle, !playbackOnline());
      if (session.remote && !track && !controller.signal.aborted) session.offlineExhausted = true;
    }
    if (!track || playback !== session || controller.signal.aborted) return;
    session.history.splice(session.index + 1, session.history.length, track);
    session.index++;
    session.played.add(track.id);
    void playTrack(track);
  } catch {
    if (!controller.signal.aborted) status("Couldn’t find the next track.");
  } finally {
    if (session.request === controller) {
      session.request = null;
      updatePlaybackControls();
    }
  }
}

async function playTrack(track, { position = 0, requested = true } = {}) {
  const generation = ++playbackGeneration;
  playbackRequested = false;
  claimPlayback = false;
  clearStreamCheck(streamPlayback);
  const pauseAtStart = pauseRevision;
  const url = audioURL(track.id);
  const saved = downloads[track.id] ? await caches.open(downloadsCache).then(async cache => {
    const response = await cache.match(url);
    return response ? response.blob() : null;
  }).catch(() => null) : null;
  if (generation !== playbackGeneration) return;
  if (!saved && !playbackOnline()) { status("Download this track before listening offline."); return; }
  streamPlayback = saved ? null : { url, position, interrupted: false, retryDelay: 1000 };
  activeTrack = track;
  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = saved ? URL.createObjectURL(saved) : null;
  pendingStartPosition = position > 0 ? position : null;
  audio.src = objectURL || url;
  if (pendingStartPosition !== null) audio.currentTime = pendingStartPosition;
  $("#playing-title").textContent = track.title;
  $("#playing-artist").textContent = songDetails(track);
  player.hidden = false;
  updatePlayerSpace();
  if (mediaSession && "MediaMetadata" in window) {
    mediaSession.metadata = new MediaMetadata({
      title: track.title, artist: track.artist || "Harbor Music", album: track.album,
      artwork: [{ src: new URL("/music/icon.png", location.href).href, type: "image/png" }],
    });
  }
  updatePlayButton();
  render();
  if (requested && pauseAtStart === pauseRevision) await resumePlayback();
  else savePlaybackBookmark(true);
}

function clearStreamCheck(stream) {
  if (!stream) return;
  clearTimeout(stream.timer);
  stream.timer = null;
  stream.probe?.abort();
  stream.probe = null;
}

function rememberStreamPosition() {
  const stream = streamPlayback;
  if (stream && !stream.interrupted && !stream.restoring && audio.readyState >= audio.HAVE_METADATA &&
      (audio.currentTime > 0 || !audio.error)) {
    stream.position = audio.currentTime;
  }
}

function scheduleStreamCheck(stream) {
  clearTimeout(stream.timer);
  stream.timer = setTimeout(() => {
    stream.timer = null;
    void checkStream(stream);
  }, stream.retryDelay);
  stream.retryDelay = Math.min(stream.retryDelay * 2, 15000);
}

function interruptStream() {
  const stream = streamPlayback;
  if (!stream || stream.interrupted) return;
  rememberStreamPosition();
  clearStreamCheck(stream);
  stream.interrupted = true;
  discardUpcoming();
  if (playbackRequested) scheduleStreamCheck(stream);
  savePlaybackBookmark(true);
  updatePlayButton();
  status();
}

async function checkStream(stream) {
  if (!pageActive || !playbackRequested || !stream?.interrupted || stream !== streamPlayback || stream.probe) return;
  clearTimeout(stream.timer);
  stream.timer = null;
  const probe = new AbortController();
  stream.probe = probe;
  const timeout = setTimeout(() => probe.abort(), 4000);
  try {
    const response = await fetch(stream.url, { method: "HEAD", cache: "no-store", signal: probe.signal });
    if (stream.probe !== probe) return;
    if (response.ok) {
      void resumePlayback();
      if (!online) void sync();
      return;
    }
    if (response.status < 500 && response.status !== 408 && response.status !== 429) {
      pausePlayback();
      status("This track is unavailable.");
      return;
    }
  } catch {
    // An unreachable server or a timed-out probe can be retried.
  } finally {
    clearTimeout(timeout);
  }
  if (stream.probe !== probe) return;
  stream.probe = null;
  scheduleStreamCheck(stream);
}

function watchStreamStall() {
  const stream = streamPlayback;
  if (!playbackRequested || !stream?.started || stream.interrupted || stream.timer || audio.ended) return;
  rememberStreamPosition();
  const position = audio.currentTime;
  stream.timer = setTimeout(() => {
    stream.timer = null;
    if (stream === streamPlayback && playbackRequested && !audio.paused && !audio.ended &&
        audio.readyState < audio.HAVE_FUTURE_DATA && audio.currentTime === position) interruptStream();
  }, 3500);
}

async function resumePlayback() {
  if (!activeTrack) return;
  const generation = playbackGeneration;
  const stream = streamPlayback;
  const pauseAtResume = pauseRevision;
  if (!playbackRequested && online && sharedPlayback && sharedPlayback.writer !== playbackWriter) {
    claimPlayback = true;
  }
  playbackRequested = true;
  if (stream?.interrupted) {
    clearStreamCheck(stream);
    stream.interrupted = false;
    stream.restoring = true;
    audio.load();
    // Set the default start time before playback. The same element retains its media permissions.
    audio.currentTime = stream.position;
  }
  savePlaybackBookmark(true);
  const audioSession = navigator.audioSession;
  if (audioSession && audioSession.type !== "playback") {
    try { audioSession.type = "playback"; }
    catch { /* Playback still works on browsers without a writable audio session. */ }
  }
  try {
    await audio.play();
  } catch (error) {
    if (generation !== playbackGeneration || pauseRevision !== pauseAtResume || error.name === "AbortError") return;
    if (error.name === "NotAllowedError") {
      playbackRequested = false;
      claimPlayback = false;
      if (stream?.restoring) stream.interrupted = true;
      clearStreamCheck(stream);
      savePlaybackBookmark(true);
      updatePlayButton();
      status(stream?.restoring || audio.currentTime > 0 || pendingStartPosition !== null ?
        "Tap Play to resume." : "Tap Play to listen.");
    } else if (!audio.error) {
      status("This track couldn’t be played.");
    }
  }
}

function pausePlayback() {
  pauseRevision++;
  playbackRequested = false;
  claimPlayback = false;
  clearStreamCheck(streamPlayback);
  if (playback?.request) {
    playback.request.abort();
    playback.request = null;
    updatePlaybackControls();
  }
  audio.pause();
  savePlaybackBookmark(true);
  updatePlayButton();
  status();
}

function playbackActive() {
  return (!audio.paused && !audio.ended && !audio.error) || Boolean(streamPlayback?.interrupted && playbackRequested);
}

function updatePlayButton() {
  const playing = playbackActive();
  playbackToggle.classList.toggle("is-playing", playing);
  playbackToggle.setAttribute("aria-label", playing ? "Pause" : "Play");
  if (mediaSession) mediaSession.playbackState = playing ? "playing" : activeTrack ? "paused" : "none";
}

function updateMediaPosition() {
  if (typeof mediaSession?.setPositionState !== "function") return;
  const { duration, currentTime, playbackRate } = audio;
  try {
    if (!Number.isFinite(duration) || duration <= 0 || playbackRate === 0) mediaSession.setPositionState();
    else mediaSession.setPositionState({ duration, position: Math.min(duration, currentTime), playbackRate });
  } catch {
    // Some implementations provide controls without a Now Playing timeline.
  }
}

function seekTo(seconds) {
  if (!Number.isFinite(seconds) || !Number.isFinite(audio.duration)) return;
  audio.currentTime = Math.min(audio.duration, Math.max(0, seconds));
  if (streamPlayback) streamPlayback.position = audio.currentTime;
  savePlaybackBookmark(true);
}

function playbackTime(seconds) {
  const time = Math.floor(seconds);
  return Math.floor(time / 60) + ":" + String(time % 60).padStart(2, "0");
}

function updatePlaybackTime() {
  const position = playbackPosition.valueAsNumber;
  const elapsed = playbackTime(position);
  const duration = Number(playbackPosition.max);
  const end = duration ? playbackTime(duration) : "–:––";
  playbackRail.style.setProperty("--seek-progress", duration ? `${100 * position / duration}%` : "0%");
  $("#playback-elapsed").textContent = elapsed;
  $("#playback-duration").textContent = end;
  playbackPosition.setAttribute("aria-valuetext", duration ? `${elapsed} of ${end}` : elapsed);
}

function updatePlaybackPosition() {
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  if (seekPointer !== null && duration) return;
  playbackPosition.disabled = !duration;
  playbackPosition.max = String(duration);
  playbackPosition.value = String(duration ? audio.currentTime : 0);
  updatePlaybackTime();
}

function resetPlaybackPosition() {
  seekPointer = null;
  updatePlaybackPosition();
}

function previewSeek(clientX) {
  const rail = playbackRail.getBoundingClientRect();
  if (!rail.width) return;
  const fraction = Math.min(1, Math.max(0, (clientX - rail.left) / rail.width));
  playbackPosition.value = String(fraction * Number(playbackPosition.max));
  updatePlaybackTime();
}

function commitSeek() {
  if (!playbackPosition.disabled) seekTo(playbackPosition.valueAsNumber);
  resetPlaybackPosition();
}

async function showDevices(getCode) {
  try {
    if (getCode) {
      $("#pair-code").textContent = "…";
      const data = await api("pair-code", {});
      $("#pair-code").textContent = data.code;
    }
    const data = await api("devices");
    $("#paired-devices").replaceChildren(...data.devices.map(device => {
      const row = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = device.name;
      row.append(name, button("Revoke", async () => {
        try {
          await api("revoke", { id: device.id });
          await showDevices(false);
        } catch (error) { status(error.message); }
      }));
      return row;
    }));
  } catch (error) {
    $("#pair-code").textContent = "Unavailable";
    status(error.message);
  }
}

sharingShortcut?.addEventListener("click", () => {
  if (!online) {
    status("Reconnect to Harbor to open Sharing.");
    return;
  }
  void HarborSharing.friends().catch(error => status(error.message));
});

$("#pair-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button");
  submit.disabled = true;
  try {
    await api("pair", Object.fromEntries(new FormData(form)));
    const session = await api("session");
    if (!session.paired) throw new Error("Open Harbor from your Home Screen or its private HTTPS address and try again.");
    online = true;
    state.known = true;
    await save();
    form.elements.code.value = "";
    void HarborSharing.configure(session.sharing, session.share_sending);
    showApp(true);
    await selectView("library");
    await sync();
  } catch (error) {
    status(error.message);
  } finally {
    submit.disabled = false;
  }
});

$("#playlist-form").addEventListener("submit", event => {
  event.preventDefault();
  const fields = event.currentTarget.elements;
  const name = fields.name.value.trim();
  if (!name) return;
  const old = state.playlists[editing];
  if (editing && !old) {
    $("#playlist-dialog").close();
    status("This playlist is no longer available.");
    return;
  }
  const playlist = old ? { ...old, name, scope: fields.scope.value } : {
    id: uid(), name, scope: fields.scope.value, revision: null, tracks: addTrack ? [addTrack] : [],
  };
  $("#playlist-dialog").close();
  addTrack = null;
  if (view === "playlists" && selectedList !== playlist.id) {
    selectedList = playlist.id;
    resetFilters();
  }
  void updatePlaylist(playlist);
});

$("#playlist-dialog").addEventListener("close", () => { addTrack = null; editing = null; });
$("#delete-playlist").addEventListener("click", () => {
  deleting = state.playlists[editing];
  if (!deleting) { $("#playlist-dialog").close(); status("This playlist is no longer available."); return; }
  const scope = deleting.scope === "local" ? "this device" : "Harbor Music on all synced devices";
  $("#delete-playlist-detail").textContent = `Remove “${deleting.name}” from ${scope}? This also clears automatic downloads with no other checked list.`;
  $("#delete-playlist-dialog").showModal();
});
$("#delete-playlist-form").addEventListener("submit", event => {
  event.preventDefault();
  $("#delete-playlist-dialog").close();
  $("#playlist-dialog").close();
  void removePlaylist(deleting);
});
$("#add-dialog").addEventListener("cancel", () => { addTrack = null; });
$("#add-new").addEventListener("click", () => { $("#add-dialog").close(); openCreate(); });
document.querySelectorAll("[data-close]").forEach(element => element.addEventListener("click", () => {
  if (element.closest("dialog").id === "add-dialog") addTrack = null;
  element.closest("dialog").close();
}));
document.querySelectorAll("[data-view]").forEach(element => element.addEventListener("click", () => { void selectView(element.dataset.view); }));
$("#devices").addEventListener("click", () => { $("#devices-dialog").showModal(); void showDevices(true); });
$("#edit-playlist-option").addEventListener("click", () => {
  const playlist = state.playlists[selectedList];
  $("#playlist-options").close();
  if (playlist) openCreate(playlist);
});
$("#share-playlist-option").addEventListener("click", () => {
  const playlist = state.playlists[selectedList];
  $("#playlist-options").close();
  if (playlist) void HarborSharing.share("playlist", playlist.name, playlist.tracks.map(track => track.id))
    .catch(error => status(error.message));
});
document.addEventListener("harbor:imported", () => {
  void sync();
  if (isBrowseView()) void loadTracks();
});
$("#new-code").addEventListener("click", () => { void showDevices(true); });
$("#more").addEventListener("click", () => { void loadTracks(true); });
window.addEventListener("scroll", scheduleListFrame, { passive: true });
window.addEventListener("resize", () => {
  updatePlayerSpace();
  const height = naturalRowHeight();
  if (height !== rowHeight) {
    rowHeight = height;
    trackList.style.setProperty("--track-height", rowHeight + "px");
    renderTrackWindow(true);
  }
  scheduleListFrame();
});
if ("IntersectionObserver" in window) {
  new IntersectionObserver(scheduleListFrame, { rootMargin: "0px 0px " + pageBuffer + "px 0px" }).observe(pageMarker);
}
function updatePlayerSpace() {
  document.documentElement.style.setProperty("--player-space", Math.ceil(player.getBoundingClientRect().height) + "px");
}
if ("ResizeObserver" in window) new ResizeObserver(updatePlayerSpace).observe(player);
if (window.visualViewport) {
  const viewport = window.visualViewport;
  const updateKeyboardSpace = () => {
    const inset = viewport.scale === 1 ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
    document.documentElement.style.setProperty("--keyboard-space", Math.round(inset) + "px");
  };
  viewport.addEventListener("resize", updateKeyboardSpace);
  viewport.addEventListener("scroll", updateKeyboardSpace, { passive: true });
}
addHoldAction($("#playing-info"), () => activeTrack);
$("#playing-info").addEventListener("click", () => { if (activeTrack) openTrackOptions(activeTrack); });
trackDialog.addEventListener("click", event => {
  if (event.target !== trackDialog) return;
  const box = trackDialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) {
    trackDialog.close();
  }
});
document.querySelectorAll("[data-track-action]").forEach(element => element.addEventListener("click", () => {
  const track = menuTrack;
  const playlist = menuPlaylist;
  if (!track) return;
  trackDialog.close();
  switch (element.dataset.trackAction) {
    case "artist":
    case "album":
      openCollection(track, element.dataset.trackAction);
      break;
    case "add":
      openAdd(track);
      break;
    case "download":
      if (downloads[track.id]) void removeDownload(track.id);
      else void downloadTracks([track]);
      break;
    case "remove":
      removeFromPlaylist(track, playlist);
      break;
    case "share":
      void HarborSharing.share("song", track.title, [track.id]).catch(error => status(error.message));
      break;
  }
}));
$("#favorite-player").addEventListener("click", () => { if (activeTrack) void markFavorite(activeTrack); });
$("#filter-button").addEventListener("click", () => { void openFilters(); });
$("#clear-filters").addEventListener("click", () => loadFilterFields({
  sort: defaultSort(), genre: "", artist: "", album: "",
}));
$("#filter-form").addEventListener("submit", event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  filters = Object.fromEntries([...form].map(([key, value]) => [key, value.trim()]));
  $("#filter-dialog").close();
  scrollToStart();
  if (isBrowseView()) void loadTracks();
  else render();
});
$("#download-form").addEventListener("submit", event => {
  event.preventDefault();
  const sources = new FormData(event.currentTarget).getAll("source");
  $("#download-dialog").close();
  void downloadSelected(sources);
});
$("#search").addEventListener("input", event => {
  query = event.target.value.trim();
  clearTimeout(searchTimer);
  if (isBrowseView()) resetTrackPages();
  searchTimer = setTimeout(() => {
    searchTimer = null;
    scrollToStart();
    if (isBrowseView()) void loadTracks();
    else render();
  }, 250);
});
$("#playback-mode").addEventListener("click", changeMode);
playbackToggle.addEventListener("click", () => {
  if (playbackActive()) pausePlayback();
  else void resumePlayback();
});
playbackPosition.addEventListener("pointerdown", event => {
  if (playbackPosition.disabled || !event.isPrimary || event.button !== 0) return;
  event.preventDefault();
  playbackPosition.focus({ preventScroll: true });
  playbackPosition.setPointerCapture(event.pointerId);
  seekPointer = event.pointerId;
  previewSeek(event.clientX);
});
playbackPosition.addEventListener("pointermove", event => {
  if (seekPointer === event.pointerId) previewSeek(event.clientX);
});
playbackPosition.addEventListener("pointerup", event => {
  if (seekPointer !== event.pointerId) return;
  previewSeek(event.clientX);
  commitSeek();
});
for (const event of ["pointercancel", "lostpointercapture"]) playbackPosition.addEventListener(event, pointer => {
  if (seekPointer === pointer.pointerId) resetPlaybackPosition();
});
playbackPosition.addEventListener("input", updatePlaybackTime);
playbackPosition.addEventListener("change", commitSeek);
playbackPosition.addEventListener("blur", resetPlaybackPosition);
for (const event of ["play", "pause", "ended", "emptied"]) audio.addEventListener(event, updatePlayButton);
for (const event of ["timeupdate", "durationchange"]) audio.addEventListener(event, updatePlaybackPosition);
for (const event of ["playing", "pause", "seeked", "durationchange", "ratechange", "emptied"]) {
  audio.addEventListener(event, updateMediaPosition);
}
audio.addEventListener("timeupdate", () => {
  rememberStreamPosition();
  savePlaybackBookmark();
});
audio.addEventListener("loadedmetadata", () => {
  const stream = streamPlayback;
  const position = pendingStartPosition ?? (stream?.restoring ? stream.position : null);
  pendingStartPosition = null;
  if (position !== null && Math.abs(audio.currentTime - position) > 0.05) seekTo(position);
});
audio.addEventListener("seeked", () => savePlaybackBookmark(true));
for (const event of ["waiting", "stalled"]) audio.addEventListener(event, watchStreamStall);
audio.addEventListener("play", () => {
  if (!audio.paused) {
    if (!playbackRequested && online && sharedPlayback && sharedPlayback.writer !== playbackWriter) {
      claimPlayback = true;
    }
    playbackRequested = true;
    savePlaybackBookmark(true);
  }
});
audio.addEventListener("pause", () => {
  const stream = streamPlayback;
  if (!document.hidden && audio.paused && !stream?.restoring && !stream?.interrupted && !audio.error) {
    playbackRequested = false;
    clearStreamCheck(stream);
    savePlaybackBookmark(true);
  }
});
audio.addEventListener("playing", () => {
  const stream = streamPlayback;
  if (stream && !audio.paused) {
    const recovered = stream.interrupted || stream.restoring;
    clearStreamCheck(stream);
    stream.started = true;
    stream.restoring = false;
    stream.interrupted = false;
    stream.retryDelay = 1000;
    rememberStreamPosition();
    if (recovered) {
      if (!online) void sync();
      status();
    }
  }
  const claim = claimPlayback;
  claimPlayback = false;
  savePlaybackBookmark(true, claim);
  prepareBackgroundTrack();
});
audio.addEventListener("emptied", resetPlaybackPosition);
$("#next").addEventListener("click", () => { void nextTrack(); });
$("#previous").addEventListener("click", previousTrack);
audio.addEventListener("ended", () => {
  playbackRequested = false;
  clearStreamCheck(streamPlayback);
  savePlaybackBookmark(true);
  void nextTrack();
});
audio.addEventListener("error", () => {
  const stream = streamPlayback;
  const error = audio.error;
  if (!activeTrack || !error) return;
  if (stream && (error.code === MediaError.MEDIA_ERR_NETWORK ||
        (error.code !== MediaError.MEDIA_ERR_ABORTED && !online && stream.position > 0) ||
        (error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED && (stream.position > 0 || !online)))) {
    interruptStream();
  } else {
    playbackRequested = false;
    clearStreamCheck(stream);
    savePlaybackBookmark(true);
    updatePlayButton();
    status("This track is unavailable.");
  }
});
setMediaAction("play", resumePlayback);
setMediaAction("pause", pausePlayback);
setMediaAction("seekto", ({ seekTime }) => seekTo(seekTime));
function checkConnection(returning = false) {
  if (!document.hidden && pageActive) {
    if (returning) resumeSharedOnReturn = true;
    void sync();
  }
  void checkStream(streamPlayback);
}

window.addEventListener("online", () => checkConnection());
window.addEventListener("focus", () => checkConnection(true));
window.addEventListener("pageshow", () => {
  pageActive = true;
  checkConnection(true);
});
window.addEventListener("offline", () => {
  watchStreamStall();
  if (online) retryDelay = 1000;
  online = false;
  resetTrackPages();
  status();
  render();
  if (!working) scheduleConnectionCheck();
});
window.addEventListener("pagehide", () => {
  savePlaybackBookmark(true);
  pageActive = false;
  clearTimeout(connectionTimer);
  clearStreamCheck(streamPlayback);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    savePlaybackBookmark(true);
    clearTimeout(connectionTimer);
    prepareBackgroundTrack();
  } else {
    discardUpcoming();
    // WebKit can signal visibility during a reload before the old page has left.
    setTimeout(() => checkConnection(true), 0);
  }
});

async function start() {
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/music/worker.js").catch(() => {});
  }
  try {
    Object.assign(state, await storage("state", "get", "music"));
    const saved = await storage("downloads", "getAll");
    const cache = await caches.open(downloadsCache);
    const cached = new Set((await cache.keys()).map(entry => new URL(entry.url).pathname));
    for (const track of saved) {
      if (track.id && cached.has(audioURL(track.id))) downloads[track.id] = track;
    }
  } catch {
    status("This device couldn’t open its offline storage.");
  }
  showApp(state.known);
  status();
  if (state.known) render();
  connectionReady = true;
  await sync();
  if (!online) restorePlaybackBookmark();
}

void start();
