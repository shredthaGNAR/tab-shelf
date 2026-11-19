// Pure data operations on the Tab Shelf state. No browser APIs here, so this
// module is unit-tested with plain Node.
//
// State shape:
// {
//   v: 1,
//   groups: { [id]: { id, name, color, order, createdAt, updatedAt } },
//   tabs:   { [id]: { id, groupId, url, title, favIconUrl, tags: [], note,
//                     savedAt, updatedAt, order } },
//   tombstones: { [id]: deletedAt }   // used by sync merge
// }

export const INBOX_ID = "inbox";
export const TOMBSTONE_TTL = 1000 * 60 * 60 * 24 * 60; // 60 days

export const GROUP_COLORS = [
  "#5b8def", "#e5484d", "#30a46c", "#f5a524", "#8e4ec6",
  "#12a594", "#e93d82", "#6e6e80",
];

let counter = 0;
export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyState(now = Date.now()) {
  return {
    v: 1,
    groups: {
      [INBOX_ID]: { id: INBOX_ID, name: "Inbox", color: GROUP_COLORS[0], order: 0, createdAt: now, updatedAt: now },
    },
    tabs: {},
    tombstones: {},
  };
}

export function ensureValid(state) {
  const s = state && typeof state === "object" ? state : emptyState();
  s.v ??= 1;
  s.groups ??= {};
  s.tabs ??= {};
  s.tombstones ??= {};
  if (!s.groups[INBOX_ID]) {
    const now = Date.now();
    s.groups[INBOX_ID] = { id: INBOX_ID, name: "Inbox", color: GROUP_COLORS[0], order: 0, createdAt: now, updatedAt: now };
  }
  for (const t of Object.values(s.tabs)) {
    if (!s.groups[t.groupId]) t.groupId = INBOX_ID;
    t.tags ??= [];
  }
  return s;
}

export function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

// ---------- URLs & duplicates ----------

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|_hsenc|_hsmi)$/i;

// Normalize a URL for duplicate detection: ignore fragment, tracking params,
// "www.", trailing slash, default ports and query-param order.
export function normalizeUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return String(url || "").trim();
  }
  if (!/^https?:$/.test(u.protocol)) return u.href;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? "?" + new URLSearchParams(params).toString() : "";
  let path = u.pathname.replace(/\/+$/, "");
  const port = u.port && !["80", "443"].includes(u.port) ? ":" + u.port : "";
  return `${host}${port}${path}${query}`;
}

export function isSaveableUrl(url) {
  return typeof url === "string" && /^(https?|ftp|file):/i.test(url);
}

// Returns arrays of tab ids that share a normalized URL (only sets of 2+),
// each array ordered oldest-saved first.
export function findDuplicates(state) {
  const byKey = new Map();
  for (const t of Object.values(state.tabs)) {
    const k = normalizeUrl(t.url);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  const out = [];
  for (const list of byKey.values()) {
    if (list.length > 1) {
      list.sort((a, b) => a.savedAt - b.savedAt);
      out.push(list.map((t) => t.id));
    }
  }
  return out;
}

// Keep the oldest copy of each duplicate set, merging tags and notes into it.
export function removeDuplicates(state, now = Date.now()) {
  const sets = findDuplicates(state);
  let removed = 0;
  for (const ids of sets) {
    const [keepId, ...drop] = ids;
    const keep = state.tabs[keepId];
    const tags = new Set(keep.tags);
    for (const id of drop) {
      const t = state.tabs[id];
      t.tags.forEach((x) => tags.add(x));
      if (t.note && !keep.note) keep.note = t.note;
      deleteTab(state, id, now);
      removed++;
    }
    keep.tags = [...tags];
    keep.updatedAt = now;
  }
  return removed;
}

export function findTabByUrl(state, url) {
  const k = normalizeUrl(url);
  return Object.values(state.tabs).find((t) => normalizeUrl(t.url) === k) || null;
}

// ---------- groups ----------

export function sortedGroups(state) {
  return Object.values(state.groups).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

export function addGroup(state, name, now = Date.now(), id = uid()) {
  const groups = sortedGroups(state);
  const order = groups.length ? groups[groups.length - 1].order + 1 : 0;
  state.groups[id] = {
    id,
    name: (name || "Untitled").trim() || "Untitled",
    color: GROUP_COLORS[groups.length % GROUP_COLORS.length],
    order,
    createdAt: now,
    updatedAt: now,
  };
  return state.groups[id];
}

export function findGroupByName(state, name) {
  const n = name.trim().toLowerCase();
  return Object.values(state.groups).find((g) => g.name.toLowerCase() === n) || null;
}

export function updateGroup(state, id, patch, now = Date.now()) {
  const g = state.groups[id];
  if (!g) return null;
  for (const k of ["name", "color"]) if (patch[k] != null) g[k] = patch[k];
  g.updatedAt = now;
  return g;
}

// Delete a group and its tabs. The inbox cannot be deleted, only emptied.
export function deleteGroup(state, id, now = Date.now()) {
  for (const t of tabsInGroup(state, id)) deleteTab(state, t.id, now);
  if (id === INBOX_ID) return;
  delete state.groups[id];
  state.tombstones[id] = now;
}

export function reorderGroup(state, id, beforeId, now = Date.now()) {
  const list = sortedGroups(state).filter((g) => g.id !== id);
  const idx = beforeId ? list.findIndex((g) => g.id === beforeId) : -1;
  list.splice(idx === -1 ? list.length : idx, 0, state.groups[id]);
  list.forEach((g, i) => {
    if (g.order !== i) {
      g.order = i;
      g.updatedAt = now;
    }
  });
}

// ---------- tabs ----------

export function tabsInGroup(state, groupId) {
  return Object.values(state.tabs)
    .filter((t) => t.groupId === groupId)
    .sort((a, b) => a.order - b.order || a.savedAt - b.savedAt);
}

// Add tabs ({url, title, favIconUrl}) to a group. With skipDuplicates, a URL
// already saved anywhere is not added again. Returns the added tab records.
export function addTabs(state, groupId, items, { skipDuplicates = true, now = Date.now() } = {}) {
  if (!state.groups[groupId]) groupId = INBOX_ID;
  const existing = new Set(Object.values(state.tabs).map((t) => normalizeUrl(t.url)));
  const inGroup = tabsInGroup(state, groupId);
  let order = inGroup.length ? inGroup[inGroup.length - 1].order + 1 : 0;
  const added = [];
  for (const it of items) {
    if (!it || !isSaveableUrl(it.url)) continue;
    const key = normalizeUrl(it.url);
    if (skipDuplicates && existing.has(key)) continue;
    existing.add(key);
    const id = uid(); // never reuse browser tab ids (numbers that repeat across saves)
    const t = {
      id,
      groupId,
      url: it.url,
      title: (it.title || it.url).slice(0, 500),
      favIconUrl: it.favIconUrl && !it.favIconUrl.startsWith("data:") ? it.favIconUrl : "",
      tags: normalizeTags(it.tags || []),
      note: it.note || "",
      savedAt: it.savedAt || now,
      updatedAt: now,
      order: order++,
    };
    state.tabs[id] = t;
    added.push(t);
  }
  return added;
}

export function deleteTab(state, id, now = Date.now()) {
  if (!state.tabs[id]) return;
  delete state.tabs[id];
  state.tombstones[id] = now;
}

// Move a tab into a group, placed before `beforeId` (or at the end).
export function moveTab(state, id, groupId, beforeId = null, now = Date.now()) {
  const t = state.tabs[id];
  if (!t || !state.groups[groupId]) return;
  const list = tabsInGroup(state, groupId).filter((x) => x.id !== id);
  const idx = beforeId ? list.findIndex((x) => x.id === beforeId) : -1;
  list.splice(idx === -1 ? list.length : idx, 0, t);
  t.groupId = groupId;
  t.updatedAt = now;
  list.forEach((x, i) => {
    if (x.order !== i) {
      x.order = i;
      x.updatedAt = now;
    }
  });
}

export function normalizeTags(tags) {
  const out = [];
  for (const raw of tags) {
    const t = String(raw).trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-").slice(0, 40);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function setTags(state, id, tags, now = Date.now()) {
  const t = state.tabs[id];
  if (!t) return;
  t.tags = normalizeTags(tags);
  t.updatedAt = now;
}

export function addTagsTo(state, id, tags, now = Date.now()) {
  const t = state.tabs[id];
  if (!t) return;
  setTags(state, id, [...t.tags, ...tags], now);
}

export function allTags(state) {
  const counts = new Map();
  for (const t of Object.values(state.tabs)) for (const tag of t.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ---------- search ----------

// Query syntax: free words match title/url/note/tags/group name (all must
// match). Filters: tag:x  group:x  site:x  -word (exclude).
export function parseQuery(q) {
  const out = { words: [], tags: [], groups: [], sites: [], not: [] };
  const re = /(-)?(?:(tag|group|site|in):)?(?:"([^"]+)"|(\S+))/gi;
  let m;
  while ((m = re.exec(q || ""))) {
    const val = (m[3] ?? m[4] ?? "").toLowerCase();
    if (!val) continue;
    const key = (m[2] || "").toLowerCase();
    if (m[1] && !key) out.not.push(val);
    else if (key === "tag") out.tags.push(val.replace(/^#/, ""));
    else if (key === "group" || key === "in") out.groups.push(val);
    else if (key === "site") out.sites.push(val);
    else if (val.startsWith("#") && val.length > 1) out.tags.push(val.slice(1));
    else out.words.push(val);
  }
  return out;
}

export function matchTab(state, t, pq) {
  const group = state.groups[t.groupId];
  const gname = (group?.name || "").toLowerCase();
  let host = "";
  try {
    host = new URL(t.url).hostname.toLowerCase();
  } catch {}
  const hay = `${t.title}\n${t.url}\n${t.note || ""}\n${t.tags.join(" ")}\n${gname}`.toLowerCase();
  if (pq.tags.some((x) => !t.tags.some((tag) => tag === x || tag.startsWith(x)))) return false;
  if (pq.groups.some((x) => !gname.includes(x))) return false;
  if (pq.sites.some((x) => !host.includes(x))) return false;
  if (pq.not.some((x) => hay.includes(x))) return false;
  return pq.words.every((w) => hay.includes(w));
}

export function search(state, q) {
  const pq = parseQuery(q);
  return Object.values(state.tabs)
    .filter((t) => matchTab(state, t, pq))
    .sort((a, b) => b.savedAt - a.savedAt);
}

// ---------- sync merge ----------

// Merge two states (e.g. local and remote). For each id the record with the
// newer updatedAt wins; a tombstone newer than the record deletes it. Records
// missing on one side are kept, so a partial remote copy never deletes data.
export function merge(a, b, now = Date.now()) {
  a = ensureValid(clone(a));
  b = ensureValid(clone(b));
  const out = { v: 1, groups: {}, tabs: {}, tombstones: {} };
  for (const src of [a.tombstones, b.tombstones]) {
    for (const [id, ts] of Object.entries(src)) {
      if (now - ts > TOMBSTONE_TTL) continue;
      out.tombstones[id] = Math.max(out.tombstones[id] || 0, ts);
    }
  }
  for (const kind of ["groups", "tabs"]) {
    const ids = new Set([...Object.keys(a[kind]), ...Object.keys(b[kind])]);
    for (const id of ids) {
      const x = a[kind][id];
      const y = b[kind][id];
      let win = !x ? y : !y ? x : y.updatedAt > x.updatedAt ? y : x;
      // Keep local-only fields (favicon) when the remote copy wins.
      if (win === y && x && kind === "tabs" && !y.favIconUrl && x.favIconUrl) win = { ...y, favIconUrl: x.favIconUrl };
      const dead = out.tombstones[id];
      if (dead && dead >= win.updatedAt && id !== INBOX_ID) continue;
      out[kind][id] = win;
    }
  }
  return ensureValid(out);
}

// A cheap stable fingerprint of the synced content, used to skip no-op pushes.
export function fingerprint(state) {
  const parts = [];
  for (const kind of ["groups", "tabs"]) {
    for (const id of Object.keys(state[kind]).sort()) parts.push(id + ":" + state[kind][id].updatedAt);
  }
  for (const id of Object.keys(state.tombstones).sort()) parts.push("x" + id + ":" + state.tombstones[id]);
  let h = 2166136261;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + ":" + parts.length;
}
