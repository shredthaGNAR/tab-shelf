// Packs state into Firefox Sync (storage.sync) sized chunks and back.
//
// storage.sync limits (Firefox): ~100 KB total, 8 KB per item, 512 items.
// We store a compact array form (no favicons), split into chunks of < 8 KB
// UTF-8 under keys "c0".."cN", plus a "meta" record. If everything does not
// fit, titles are shortened and then the oldest tabs are left out of sync
// (they stay on this device; merge never deletes missing records).

import { ensureValid } from "./ops.js";

export const CHUNK_PREFIX = "c";
export const META_KEY = "meta";
const ITEM_BYTES = 8192 - 300; // margin for key name and JSON quoting
const TOTAL_BYTES = 102400 - 4000; // margin for meta record
const enc = new TextEncoder();
const bytes = (s) => enc.encode(s).length;

function compact(state, { titleMax = 300, tabLimit = Infinity } = {}) {
  const g = Object.values(state.groups).map((x) => [x.id, x.name, x.color, x.order, x.createdAt, x.updatedAt]);
  let tabs = Object.values(state.tabs);
  if (tabs.length > tabLimit) tabs = tabs.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, tabLimit);
  const t = tabs.map((x) => [
    x.id, x.groupId, x.url, (x.title || "").slice(0, titleMax), x.tags, x.note || "", x.savedAt, x.updatedAt, x.order,
  ]);
  const d = Object.entries(state.tombstones);
  return { g, t, d };
}

function expand(c) {
  const state = { v: 1, groups: {}, tabs: {}, tombstones: {} };
  for (const [id, name, color, order, createdAt, updatedAt] of c.g || []) {
    state.groups[id] = { id, name, color, order, createdAt, updatedAt };
  }
  for (const [id, groupId, url, title, tags, note, savedAt, updatedAt, order] of c.t || []) {
    state.tabs[id] = { id, groupId, url, title, favIconUrl: "", tags: tags || [], note, savedAt, updatedAt, order };
  }
  for (const [id, ts] of c.d || []) state.tombstones[id] = ts;
  return ensureValid(state);
}

// Split a string into pieces whose JSON-encoded UTF-8 size is under max.
export function chunkString(str, max = ITEM_BYTES) {
  const out = [];
  let start = 0;
  while (start < str.length) {
    // Estimate, then shrink until it fits.
    let end = Math.min(str.length, start + max);
    while (bytes(JSON.stringify(str.slice(start, end))) > max) {
      end = start + Math.floor((end - start) * 0.85);
    }
    // Avoid splitting a surrogate pair.
    if (end < str.length && /[\uD800-\uDBFF]/.test(str[end - 1])) end--;
    out.push(str.slice(start, end));
    start = end;
  }
  return out;
}

// Returns { items: {key: value}, meta } ready for storage.sync.set().
export function pack(state, deviceId = "", now = Date.now()) {
  const total = Object.keys(state.tabs).length;
  const attempts = [{ titleMax: 300 }, { titleMax: 120 }, { titleMax: 60 }];
  let json;
  let opts;
  for (opts of attempts) {
    json = JSON.stringify(compact(state, opts));
    if (bytes(json) < TOTAL_BYTES) break;
  }
  let tabLimit = total;
  while (bytes(json) >= TOTAL_BYTES && tabLimit > 0) {
    tabLimit = Math.floor(tabLimit * 0.9);
    json = JSON.stringify(compact(state, { ...opts, tabLimit }));
  }
  const chunks = chunkString(json);
  const items = {};
  chunks.forEach((c, i) => (items[CHUNK_PREFIX + i] = c));
  const meta = { chunks: chunks.length, updatedAt: now, deviceId, synced: tabLimit, total, partial: tabLimit < total };
  items[META_KEY] = meta;
  return { items, meta };
}

// Takes the full object from storage.sync.get(null). Returns null if empty or
// if the chunk set is incomplete (another device is mid-write).
export function unpack(all) {
  const meta = all?.[META_KEY];
  if (!meta || !meta.chunks) return null;
  let json = "";
  for (let i = 0; i < meta.chunks; i++) {
    const c = all[CHUNK_PREFIX + i];
    if (typeof c !== "string") return null;
    json += c;
  }
  try {
    return { state: expand(JSON.parse(json)), meta };
  } catch {
    return null;
  }
}

// Keys from a previous, longer write that should be removed.
export function staleKeys(all, meta) {
  return Object.keys(all || {}).filter((k) => {
    const m = /^c(\d+)$/.exec(k);
    return m && Number(m[1]) >= meta.chunks;
  });
}
