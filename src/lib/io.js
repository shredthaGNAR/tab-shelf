// Import / export formats.
//   - Tab Shelf JSON (full fidelity)
//   - OneTab text ("url | title" per line, blank line between groups)
//   - Netscape bookmarks HTML (what every browser imports/exports)
//   - Plain list of URLs (any text; URLs are pulled out of it)

import { addGroup, addTabs, findGroupByName, sortedGroups, tabsInGroup, INBOX_ID, normalizeTags } from "./ops.js";

export function detectFormat(text) {
  const s = text.trimStart();
  if (s.startsWith("{")) return "json";
  if (/^<!DOCTYPE NETSCAPE-Bookmark-file/i.test(s) || /<DT>\s*<A\s/i.test(s)) return "html";
  if (/^\S+:\/\/\S+ \| /m.test(s)) return "onetab";
  return "urls";
}

// ---------- export ----------

export function exportJSON(state) {
  const groups = sortedGroups(state).map((g) => ({
    name: g.name,
    color: g.color,
    createdAt: g.createdAt,
    tabs: tabsInGroup(state, g.id).map((t) => ({
      url: t.url,
      title: t.title,
      tags: t.tags,
      note: t.note || undefined,
      savedAt: t.savedAt,
    })),
  }));
  return JSON.stringify({ format: "tab-shelf", version: 1, exportedAt: new Date().toISOString(), groups }, null, 2);
}

export function exportOneTab(state) {
  return sortedGroups(state)
    .map((g) => tabsInGroup(state, g.id).map((t) => `${t.url} | ${t.title}`).join("\n"))
    .filter(Boolean)
    .join("\n\n") + "\n";
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function exportHTML(state) {
  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Tab Shelf</TITLE>",
    "<H1>Tab Shelf</H1>",
    "<DL><p>",
  ];
  for (const g of sortedGroups(state)) {
    const tabs = tabsInGroup(state, g.id);
    if (!tabs.length) continue;
    lines.push(`  <DT><H3 ADD_DATE="${Math.floor(g.createdAt / 1000)}">${esc(g.name)}</H3>`, "  <DL><p>");
    for (const t of tabs) {
      const tags = t.tags.length ? ` TAGS="${esc(t.tags.join(","))}"` : "";
      lines.push(`    <DT><A HREF="${esc(t.url)}" ADD_DATE="${Math.floor(t.savedAt / 1000)}"${tags}>${esc(t.title)}</A>`);
    }
    lines.push("  </DL><p>");
  }
  lines.push("</DL><p>");
  return lines.join("\n") + "\n";
}

// ---------- import ----------

// Parse any supported text into [{ name, tabs: [{url, title, tags, savedAt}] }].
export function parseImport(text, format = detectFormat(text)) {
  switch (format) {
    case "json":
      return parseJSON(text);
    case "html":
      return parseHTML(text);
    case "onetab":
      return parseOneTab(text);
    default:
      return parseUrls(text);
  }
}

function parseJSON(text) {
  const data = JSON.parse(text);
  // Our export format
  if (Array.isArray(data.groups) && data.groups.every((g) => Array.isArray(g.tabs))) {
    return data.groups.map((g) => ({ name: g.name || "Imported", tabs: g.tabs }));
  }
  // A raw state object (e.g. a backup of storage)
  if (data.groups && data.tabs && typeof data.tabs === "object") {
    return Object.values(data.groups).map((g) => ({
      name: g.name,
      tabs: Object.values(data.tabs).filter((t) => t.groupId === g.id),
    }));
  }
  // Session-manager style: { windows: [{ tabs: [{url,title}] }] }
  if (Array.isArray(data.windows)) {
    return data.windows.map((w, i) => ({ name: `Window ${i + 1}`, tabs: w.tabs || [] }));
  }
  throw new Error("Unrecognised JSON format");
}

function parseOneTab(text) {
  const groups = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      cur = null;
      continue;
    }
    const i = line.indexOf(" | ");
    const url = (i === -1 ? line : line.slice(0, i)).trim();
    const title = i === -1 ? url : line.slice(i + 3).trim();
    if (!/^\S+:\/\//.test(url)) continue;
    if (!cur) groups.push((cur = { name: `OneTab ${groups.length + 1}`, tabs: [] }));
    cur.tabs.push({ url, title });
  }
  return groups;
}

const decode = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function parseHTML(text) {
  // A small tolerant parser: walks <H3> folder headings and <A> links. Nested
  // folders are flattened into "Parent / Child" group names.
  const groups = new Map();
  const stack = [];
  let pendingFolder = null;
  const re = /<H3[^>]*>([\s\S]*?)<\/H3>|<A\s([^>]*)>([\s\S]*?)<\/A>|<DL>|<\/DL>/gi;
  let m;
  while ((m = re.exec(text))) {
    const tok = m[0].slice(0, 4).toUpperCase();
    if (m[1] !== undefined) pendingFolder = decode(m[1].trim());
    else if (tok === "<DL>") {
      stack.push(pendingFolder);
      pendingFolder = null;
    } else if (tok === "</DL") stack.pop();
    else if (m[2] !== undefined) {
      const href = /HREF="([^"]*)"/i.exec(m[2]);
      if (!href) continue;
      const date = /ADD_DATE="(\d+)"/i.exec(m[2]);
      const tags = /TAGS="([^"]*)"/i.exec(m[2]);
      const name = stack.filter(Boolean).join(" / ") || "Imported bookmarks";
      if (!groups.has(name)) groups.set(name, { name, tabs: [] });
      groups.get(name).tabs.push({
        url: decode(href[1]),
        title: decode(m[3].replace(/<[^>]+>/g, "").trim()),
        savedAt: date ? Number(date[1]) * 1000 : undefined,
        tags: tags ? decode(tags[1]).split(",") : [],
      });
    }
  }
  return [...groups.values()];
}

function parseUrls(text) {
  const urls = text.match(/\b(?:https?|ftp|file):\/\/[^\s<>"'|]+/gi) || [];
  return urls.length ? [{ name: "Imported links", tabs: urls.map((url) => ({ url, title: url })) }] : [];
}

// Apply parsed groups to state. Groups merge into existing groups with the
// same name. Returns { added, skipped, groups }.
export function applyImport(state, parsed, { skipDuplicates = true, now = Date.now() } = {}) {
  let added = 0;
  let total = 0;
  for (const g of parsed) {
    const tabs = (g.tabs || []).map((t) => ({ ...t, tags: normalizeTags(t.tags || []) }));
    total += tabs.length;
    if (!tabs.length) continue;
    const name = (g.name || "Imported").trim();
    const group = name.toLowerCase() === "inbox" ? state.groups[INBOX_ID] : findGroupByName(state, name) || addGroup(state, name, now);
    added += addTabs(state, group.id, tabs, { skipDuplicates, now }).length;
  }
  return { added, skipped: total - added, groups: parsed.length };
}
