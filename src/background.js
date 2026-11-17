import * as ops from "./lib/ops.js";
import { mutate, loadState, loadSettings, saveSettings, setStatus, STATE_KEY, SETTINGS_KEY } from "./lib/store.js";
import { pack, unpack, staleKeys } from "./lib/syncpack.js";
import { suggestTags, testConnection } from "./lib/ai.js";
import { parseImport, applyImport, exportJSON, exportOneTab, exportHTML } from "./lib/io.js";

const MANAGER_URL = browser.runtime.getURL("manager/manager.html");

// Ops the UI pages may run on state through the "op" message.
const ALLOWED_OPS = new Set([
  "addGroup", "updateGroup", "deleteGroup", "reorderGroup", "moveTab", "deleteTab",
  "setTags", "addTagsTo", "removeDuplicates",
]);

// ---------------------------------------------------------------- saving

function sessionName(now = new Date()) {
  return "Session · " + now.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function tabsForScope(scope) {
  switch (scope) {
    case "current":
      return browser.tabs.query({ active: true, currentWindow: true });
    case "selected": {
      const hl = await browser.tabs.query({ highlighted: true, currentWindow: true });
      return hl.length ? hl : browser.tabs.query({ active: true, currentWindow: true });
    }
    case "window":
      return browser.tabs.query({ currentWindow: true });
    case "all":
      return browser.tabs.query({});
    default:
      return [];
  }
}

// Save browser tabs. groupId "new-session" creates a dated group.
async function saveTabs({ scope = "current", groupId, groupName, tabs: given, close } = {}) {
  const settings = await loadSettings();
  const browserTabs = given || (await tabsForScope(scope));
  const items = browserTabs.filter((t) => ops.isSaveableUrl(t.url) && t.url !== MANAGER_URL);
  const useSession = groupId === "new-session" || (!groupId && (scope === "window" || scope === "all"));
  const added = await mutate((state) => {
    let gid = groupId || settings.defaultGroupId;
    if (useSession || groupName) gid = ops.addGroup(state, groupName || sessionName()).id;
    if (!state.groups[gid]) gid = ops.INBOX_ID;
    return ops.addTabs(state, gid, items, { skipDuplicates: settings.skipDuplicates });
  });
  const shouldClose = close ?? settings.closeAfterSave;
  if (shouldClose && !given) await closeSaved(items);
  flashBadge(added.length ? `+${added.length}` : "0");
  if (added.length) queueAutoTag(added.map((t) => t.id));
  return { added: added.length, skipped: items.length - added.length };
}

async function closeSaved(tabs) {
  const ids = tabs.filter((t) => !t.pinned).map((t) => t.id);
  if (!ids.length) return;
  // Keep each affected window alive by opening the manager first if needed.
  const windows = new Set(tabs.map((t) => t.windowId));
  for (const windowId of windows) {
    const remaining = await browser.tabs.query({ windowId });
    if (remaining.every((t) => ids.includes(t.id))) await browser.tabs.create({ windowId, url: MANAGER_URL });
  }
  await browser.tabs.remove(ids);
}

async function saveUrl({ url, title, groupId }) {
  const settings = await loadSettings();
  const added = await mutate((state) =>
    ops.addTabs(state, groupId || settings.defaultGroupId, [{ url, title }], { skipDuplicates: settings.skipDuplicates }),
  );
  flashBadge(added.length ? "+1" : "0");
  if (added.length) queueAutoTag(added.map((t) => t.id));
  return { added: added.length };
}

let badgeTimer;
function flashBadge(text) {
  browser.action.setBadgeBackgroundColor({ color: text === "0" ? "#6e6e80" : "#30a46c" });
  browser.action.setBadgeText({ text });
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => browser.action.setBadgeText({ text: "" }), 2500);
}

// ---------------------------------------------------------------- restoring

async function openTabs({ ids, newWindow, remove }) {
  const settings = await loadSettings();
  const state = await loadState();
  const tabs = ids.map((id) => state.tabs[id]).filter(Boolean);
  if (!tabs.length) return { opened: 0 };
  newWindow ??= settings.restoreInNewWindow && tabs.length > 1;
  remove ??= settings.removeOnRestore;
  let windowId;
  if (newWindow) {
    const w = await browser.windows.create({ url: tabs[0].url });
    windowId = w.id;
  }
  for (let i = newWindow ? 1 : 0; i < tabs.length; i++) {
    const t = tabs[i];
    const props = { url: t.url, windowId, active: i === 0 && !newWindow };
    // Load lazily so restoring a big group does not hit the network at once.
    if (!props.active && tabs.length > 1 && /^https?:/.test(t.url)) Object.assign(props, { discarded: true, title: t.title });
    try {
      await browser.tabs.create(props);
    } catch {
      await browser.tabs.create({ url: t.url, windowId, active: false });
    }
  }
  if (remove) await mutate((state) => ids.forEach((id) => ops.deleteTab(state, id)));
  return { opened: tabs.length };
}

async function openManager(query) {
  const url = MANAGER_URL + (query ? `#${encodeURIComponent(query)}` : "");
  const [existing] = await browser.tabs.query({ url: MANAGER_URL + "*" });
  if (existing) {
    await browser.tabs.update(existing.id, { active: true, url });
    await browser.windows.update(existing.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url });
  }
}

// ---------------------------------------------------------------- AI tagging

let tagQueue = new Set();
let tagTimer;

async function queueAutoTag(ids) {
  const { ai } = await loadSettings();
  if (!ai.autoTag || !ai.apiKey) return;
  ids.forEach((id) => tagQueue.add(id));
  clearTimeout(tagTimer);
  tagTimer = setTimeout(() => {
    const batch = [...tagQueue];
    tagQueue = new Set();
    aiTag({ ids: batch, onlyUntagged: false }).catch(() => {});
  }, 1500);
}

async function aiTag({ ids, onlyUntagged = true } = {}) {
  const { ai } = await loadSettings();
  const state = await loadState();
  let tabs = ids ? ids.map((id) => state.tabs[id]).filter(Boolean) : Object.values(state.tabs);
  if (onlyUntagged) tabs = tabs.filter((t) => !t.tags.length);
  if (!tabs.length) return { tagged: 0 };
  const vocab = ops.allTags(state).map(([t]) => t);
  try {
    const result = await suggestTags(ai, tabs, vocab);
    const n = await mutate((s) => {
      let c = 0;
      for (const [id, tags] of Object.entries(result)) {
        if (s.tabs[id] && tags.length) {
          ops.addTagsTo(s, id, tags);
          c++;
        }
      }
      return c;
    });
    await setStatus({ aiError: "", aiLastRun: Date.now() });
    return { tagged: n };
  } catch (e) {
    await setStatus({ aiError: String(e.message || e), aiLastRun: Date.now() });
    throw e;
  }
}

// ---------------------------------------------------------------- sync

let syncTimer;
let syncing = false;

function scheduleSync(delay = 4000) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow().catch((e) => setStatus({ syncError: String(e.message || e) })), delay);
}

async function deviceId() {
  const r = await browser.storage.local.get("deviceId");
  if (r.deviceId) return r.deviceId;
  const id = ops.uid();
  await browser.storage.local.set({ deviceId: id });
  return id;
}

async function syncNow() {
  const settings = await loadSettings();
  if (!settings.syncEnabled || syncing) return { skipped: true };
  syncing = true;
  try {
    const all = await browser.storage.sync.get(null);
    const remote = unpack(all);
    const local = await loadState();
    let merged = local;
    if (remote) {
      merged = ops.merge(local, remote.state);
      if (ops.fingerprint(merged) !== ops.fingerprint(local)) {
        await mutate((s) => {
          // Re-merge against the freshest local copy inside the queue.
          const fresh = ops.merge(s, remote.state);
          Object.assign(s, fresh);
        });
        merged = await loadState();
      }
    }
    const { items, meta } = pack(merged, await deviceId());
    const packedFp = ops.fingerprint(unpack(items).state);
    const { lastPushed } = (await browser.storage.local.get("lastPushed")) || {};
    if (!(remote && packedFp === ops.fingerprint(remote.state)) && packedFp !== lastPushed) {
      await browser.storage.sync.set(items);
      const stale = staleKeys(all, meta);
      if (stale.length) await browser.storage.sync.remove(stale);
    }
    await browser.storage.local.set({ lastPushed: packedFp });
    await setStatus({ syncError: "", syncedAt: Date.now(), syncPartial: meta.partial, syncCount: meta.synced, syncTotal: meta.total });
    return { ok: true, partial: meta.partial };
  } catch (e) {
    await setStatus({ syncError: String(e.message || e) });
    throw e;
  } finally {
    syncing = false;
  }
}

// ---------------------------------------------------------------- page action

async function refreshPageAction(tabId, url) {
  try {
    if (!ops.isSaveableUrl(url) || url.startsWith(MANAGER_URL)) return;
    const state = await loadState();
    const saved = ops.findTabByUrl(state, url);
    await browser.pageAction.setIcon({ tabId, path: saved ? "icons/saved.svg" : "icons/save.svg" });
    await browser.pageAction.setTitle({
      tabId,
      title: saved ? `Saved in "${state.groups[saved.groupId]?.name}" (click to view)` : "Save tab to Tab Shelf",
    });
  } catch {
    // Tab may have closed.
  }
}

async function refreshActivePageActions() {
  const tabs = await browser.tabs.query({ active: true });
  await Promise.all(tabs.map((t) => refreshPageAction(t.id, t.url)));
}

browser.pageAction.onClicked.addListener(async (tab) => {
  const state = await loadState();
  const saved = ops.findTabByUrl(state, tab.url);
  if (saved) await openManager(saved.url);
  else await saveTabs({ scope: "current", tabs: [tab] });
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await browser.tabs.get(tabId);
  refreshPageAction(tabId, tab.url);
});
browser.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === "complete") refreshPageAction(tabId, tab.url);
});

// ---------------------------------------------------------------- menus & commands

async function setupMenus() {
  await browser.menus.removeAll();
  browser.menus.create({ id: "save-page", title: "Save page to Tab Shelf", contexts: ["page", "tab"] });
  browser.menus.create({ id: "save-link", title: "Save link to Tab Shelf", contexts: ["link"] });
  browser.menus.create({ id: "save-window", title: "Save all tabs in window as session", contexts: ["page", "tab"] });
  browser.menus.create({ id: "open-manager", title: "Open Tab Shelf", contexts: ["action", "tab"] });
}

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "save-page") {
    // If the clicked tab is part of a multi-selection, save the whole selection.
    const hl = tab?.highlighted ? await browser.tabs.query({ highlighted: true, windowId: tab.windowId }) : [];
    await saveTabs({ tabs: hl.length > 1 ? hl : [tab] });
  } else if (info.menuItemId === "save-link") {
    await saveUrl({ url: info.linkUrl, title: info.linkText || info.linkUrl });
  } else if (info.menuItemId === "save-window") {
    await saveTabs({ scope: "window" });
  } else if (info.menuItemId === "open-manager") {
    await openManager();
  }
});

browser.commands.onCommand.addListener(async (command) => {
  if (command === "save-tab") await saveTabs({ scope: "selected" });
  else if (command === "save-window") await saveTabs({ scope: "window" });
  else if (command === "open-manager") await openManager();
});

// ---------------------------------------------------------------- messages

browser.runtime.onMessage.addListener((msg) => {
  switch (msg?.cmd) {
    case "saveTabs":
      return saveTabs(msg);
    case "saveUrl":
      return saveUrl(msg);
    case "openTabs":
      return openTabs(msg);
    case "openManager":
      return openManager(msg.query);
    case "op":
      if (!ALLOWED_OPS.has(msg.name)) return Promise.reject(new Error("Unknown op " + msg.name));
      return mutate((state) => {
        const r = ops[msg.name](state, ...(msg.args || []));
        return r && typeof r === "object" && !Array.isArray(r) ? { ...r } : r;
      });
    case "deleteTabs":
      return mutate((state) => msg.ids.forEach((id) => ops.deleteTab(state, id)));
    case "moveTabs":
      return mutate((state) => msg.ids.forEach((id) => ops.moveTab(state, id, msg.groupId, msg.beforeId)));
    case "tagTabs":
      return mutate((state) => msg.ids.forEach((id) => ops.addTagsTo(state, id, msg.tags)));
    case "aiTag":
      return aiTag(msg);
    case "testAI":
      return loadSettings().then((s) => testConnection({ ...s.ai, ...(msg.ai || {}) }));
    case "import":
      return (async () => {
        const settings = await loadSettings();
        const parsed = parseImport(msg.text, msg.format);
        const before = new Set(Object.keys((await loadState()).tabs));
        const res = await mutate((state) => applyImport(state, parsed, { skipDuplicates: settings.skipDuplicates }));
        if (msg.autoTag) {
          const s = await loadState();
          queueAutoTag(Object.keys(s.tabs).filter((id) => !before.has(id)));
        }
        return res;
      })();
    case "export":
      return loadState().then((s) =>
        msg.format === "onetab" ? exportOneTab(s) : msg.format === "html" ? exportHTML(s) : exportJSON(s),
      );
    case "syncNow":
      return syncNow();
    case "saveSettings":
      return saveSettings(msg.patch);
  }
  return undefined;
});

// ---------------------------------------------------------------- lifecycle

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STATE_KEY]) {
    scheduleSync();
    refreshActivePageActions();
  }
  if (area === "local" && changes[SETTINGS_KEY]) {
    const o = changes[SETTINGS_KEY].oldValue;
    const n = changes[SETTINGS_KEY].newValue;
    if (n?.syncEnabled && !o?.syncEnabled) scheduleSync(500);
  }
  if (area === "sync") scheduleSync(1500);
});

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  setupMenus();
  await mutate(() => {}); // writes an initial state with the Inbox
  if (reason === "install") browser.tabs.create({ url: MANAGER_URL + "#welcome" });
  scheduleSync(2000);
});

browser.runtime.onStartup.addListener(() => {
  setupMenus();
  scheduleSync(5000);
});
