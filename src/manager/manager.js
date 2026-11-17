import { ensureValid, sortedGroups, tabsInGroup, parseQuery, matchTab, allTags, findDuplicates, INBOX_ID } from "../lib/ops.js";
import { send, op, el, favicon, hostOf, timeAgo, toast, applyTheme } from "../ui/util.js";

const $ = (id) => document.getElementById(id);
const DND_TYPE = "application/x-tab-shelf-ids";

let state = ensureValid(null);
let status = {};
let activeGroup = ""; // "" = all groups
const selected = new Set();
let pendingRender = false;
let dragIds = null;

// ------------------------------------------------------------------ data

async function load() {
  const r = await browser.storage.local.get(["state", "status"]);
  state = ensureValid(r.state);
  status = r.status || {};
  for (const id of [...selected]) if (!state.tabs[id]) selected.delete(id);
  if (activeGroup && !state.groups[activeGroup]) activeGroup = "";
  render();
}

browser.storage.onChanged.addListener((c, area) => {
  if (area !== "local") return;
  if (c.state || c.status) {
    // Don't yank an input out from under the user; render when they're done.
    if (document.activeElement?.matches?.("main .tab input, main .group-head input")) pendingRender = true;
    else load();
  }
  if (c.settings) applyTheme();
});

document.addEventListener("focusout", () => {
  if (pendingRender) {
    pendingRender = false;
    setTimeout(load, 0);
  }
});

// ------------------------------------------------------------------ render

function render() {
  renderSidebar();
  renderContent();
  renderSelbar();
}

function renderSidebar() {
  const counts = {};
  for (const t of Object.values(state.tabs)) counts[t.groupId] = (counts[t.groupId] || 0) + 1;
  $("count-all").textContent = Object.keys(state.tabs).length;
  $("nav-all").classList.toggle("active", !activeGroup);

  $("group-nav").replaceChildren(
    ...sortedGroups(state).map((g) => {
      const b = el("button", {
        class: "nav-item" + (activeGroup === g.id ? " active" : ""),
        draggable: "true",
        dataset: { group: g.id },
        title: g.name,
        onclick: () => {
          activeGroup = g.id;
          render();
          window.scrollTo({ top: 0 });
        },
      },
        el("span", { class: "dot", style: { background: g.color } }),
        el("span", { class: "name" }, g.name),
        el("span", { class: "count" }, String(counts[g.id] || 0)),
      );
      makeDropTarget(b, () => ({ groupId: g.id }));
      // Groups can be reordered by dragging in the sidebar.
      b.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("application/x-tab-shelf-group", g.id);
        e.dataTransfer.effectAllowed = "move";
      });
      return el("li", {}, b);
    }),
  );

  const pq = parseQuery($("q").value);
  $("tag-cloud").replaceChildren(
    ...allTags(state).slice(0, 60).map(([tag, n]) =>
      el("span", {
        class: "tag" + (pq.tags.includes(tag) ? " active" : ""),
        title: `${n} tab${n === 1 ? "" : "s"}`,
        role: "button",
        tabindex: "0",
        onclick: () => toggleTagFilter(tag),
        onkeydown: (e) => e.key === "Enter" && toggleTagFilter(tag),
      }, `#${tag} `, el("span", { class: "muted" }, String(n))),
    ),
  );
  if (!allTags(state).length) $("tag-cloud").append(el("span", { class: "muted" }, "No tags yet"));

  const bits = [];
  if (status.syncError) bits.push(`Sync error: ${status.syncError}`);
  else if (status.syncedAt) {
    bits.push(`Synced ${timeAgo(status.syncedAt)}`);
    if (status.syncPartial) bits.push(`(${status.syncCount} of ${status.syncTotal} tabs fit in Firefox Sync)`);
  }
  if (status.aiError) bits.push(`AI: ${status.aiError}`);
  $("sync-status").textContent = bits.join(" ");
}

function toggleTagFilter(tag) {
  const q = $("q").value;
  const token = `tag:${tag}`;
  const parts = q.split(/\s+/).filter(Boolean);
  $("q").value = parts.includes(token) ? parts.filter((p) => p !== token).join(" ") : [...parts, token].join(" ");
  onSearch();
}

function renderContent() {
  const pq = parseQuery($("q").value);
  const searching = $("q").value.trim().length > 0;
  const groups = sortedGroups(state).filter((g) => !activeGroup || g.id === activeGroup);
  const frag = document.createDocumentFragment();
  let shown = 0;

  for (const g of groups) {
    let tabs = tabsInGroup(state, g.id);
    if (searching) tabs = tabs.filter((t) => matchTab(state, t, pq));
    if (searching && !tabs.length) continue;
    shown += tabs.length;
    frag.append(renderGroup(g, tabs, searching));
  }
  $("content").replaceChildren(frag);
  const nothing = $("nothing");
  if (searching && !shown) {
    nothing.hidden = false;
    nothing.textContent = "No saved tabs match your search.";
  } else if (!Object.keys(state.tabs).length) {
    nothing.hidden = false;
    nothing.textContent = "Your shelf is empty. Save tabs with the toolbar button, the address bar icon, or Alt+Shift+S.";
  } else nothing.hidden = true;
}

function renderGroup(g, tabs, searching) {
  const total = tabsInGroup(state, g.id).length;
  const list = el("ul", { class: "tabs", dataset: { group: g.id } });
  if (!tabs.length) list.append(el("li", { class: "empty-drop" }, "Empty group. Drag tabs here."));
  for (const t of tabs) list.append(renderTab(t));
  makeDropTarget(list, (e) => {
    const row = e.target.closest?.(".tab");
    if (row && dragIds?.includes(row.dataset.id)) return { groupId: g.id, noop: true };
    return { groupId: g.id, beforeId: row ? row.dataset.id : null };
  });

  const title = el("h2", { title: "Double-click to rename", ondblclick: () => renameGroup(g, title) }, g.name);
  const color = el("input", {
    type: "color",
    value: g.color,
    title: "Group colour",
    "aria-label": "Group colour",
    onchange: (e) => op("updateGroup", g.id, { color: e.target.value }),
  });
  const ids = tabs.map((t) => t.id);
  const head = el("div", { class: "group-head", style: { "--gcolor": g.color } },
    color,
    title,
    el("span", { class: "meta" }, searching ? `${tabs.length} of ${total}` : `${total} tab${total === 1 ? "" : "s"} · ${timeAgo(g.createdAt)}`),
    el("div", { class: "tools" },
      el("button", { class: "ghost", disabled: !ids.length, onclick: () => send("openTabs", { ids }) }, "Open all"),
      el("button", { class: "ghost", disabled: !ids.length, onclick: () => send("openTabs", { ids, newWindow: true }) }, "New window"),
      el("button", { class: "ghost", disabled: !ids.length, onclick: () => send("openTabs", { ids, remove: true }) , title: "Open the tabs and remove them from the shelf" }, "Restore & remove"),
      el("button", { class: "ghost", disabled: !ids.length, onclick: () => {
        ids.forEach((id) => selected.add(id));
        render();
      } }, "Select"),
      el("button", { class: "ghost", onclick: () => renameGroup(g, title) }, "Rename"),
      el("button", { class: "ghost danger", onclick: () => deleteGroup(g, total) }, g.id === INBOX_ID ? "Empty" : "Delete"),
    ),
  );
  makeDropTarget(head, () => ({ groupId: g.id }));
  return el("section", { class: "group", dataset: { group: g.id } }, head, list);
}

function renderTab(t) {
  const isSel = selected.has(t.id);
  const tagsBox = el("span", { class: "tags" },
    ...t.tags.map((tag) => el("span", { class: "tag", title: "Filter by tag", onclick: () => toggleTagFilter(tag) }, `#${tag}`)),
  );
  const row = el("li", {
    class: "tab" + (isSel ? " selected" : ""),
    draggable: "true",
    dataset: { id: t.id },
  },
    el("input", {
      type: "checkbox",
      checked: isSel,
      "aria-label": "Select",
      onclick: (e) => toggleSelect(t.id, e),
    }),
    favicon(t),
    el("div", { class: "main" },
      el("a", {
        class: "title",
        href: t.url,
        title: t.url,
        onclick: (e) => {
          e.preventDefault();
          send("openTabs", { ids: [t.id], newWindow: e.shiftKey });
        },
        onauxclick: (e) => {
          if (e.button === 1) {
            e.preventDefault();
            send("openTabs", { ids: [t.id] });
          }
        },
      }, t.title || t.url),
      el("div", { class: "sub" }, el("span", { class: "host" }, hostOf(t.url)), el("span", {}, "·"), el("span", {}, timeAgo(t.savedAt)), tagsBox),
    ),
    el("div", { class: "row-tools" },
      el("button", { class: "ghost", title: "Edit tags", onclick: () => editTags(t, tagsBox) }, "Tags"),
      el("button", { class: "ghost", title: "Copy link", onclick: () => navigator.clipboard.writeText(t.url).then(() => toast("Link copied")) }, "Copy"),
      el("button", { class: "ghost danger", title: "Delete", "aria-label": "Delete", onclick: () => send("deleteTabs", { ids: [t.id] }) }, "✕"),
    ),
  );
  row.addEventListener("dragstart", (e) => {
    dragIds = selected.has(t.id) ? [...selected] : [t.id];
    e.dataTransfer.setData(DND_TYPE, JSON.stringify(dragIds));
    // Also let users drop a tab onto the tab strip / other apps.
    e.dataTransfer.setData("text/uri-list", t.url);
    e.dataTransfer.setData("text/plain", t.url);
    e.dataTransfer.effectAllowed = "copyMove";
    requestAnimationFrame(() => document.querySelectorAll(dragIds.map((id) => `.tab[data-id="${CSS.escape(id)}"]`).join(",")).forEach((n) => n.classList.add("dragging")));
  });
  row.addEventListener("dragend", () => {
    dragIds = null;
    document.querySelectorAll(".dragging, .drop-before, .drop-target").forEach((n) => n.classList.remove("dragging", "drop-before", "drop-target"));
  });
  return row;
}

// ------------------------------------------------------------------ drag & drop

function makeDropTarget(node, where) {
  node.addEventListener("dragover", (e) => {
    const types = e.dataTransfer.types;
    const isGroup = types.includes("application/x-tab-shelf-group");
    if (!types.includes(DND_TYPE) && !isGroup && !types.includes("text/uri-list")) return;
    if (isGroup && !node.classList.contains("nav-item")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = types.includes(DND_TYPE) || isGroup ? "move" : "copy";
    document.querySelectorAll(".drop-before, .drop-target").forEach((n) => n.classList.remove("drop-before", "drop-target"));
    const row = e.target.closest?.(".tab");
    if (row && node.contains(row) && !isGroup) row.classList.add("drop-before");
    else node.classList.add("drop-target");
  });
  node.addEventListener("dragleave", (e) => {
    if (!node.contains(e.relatedTarget)) node.classList.remove("drop-target");
  });
  node.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll(".drop-before, .drop-target").forEach((n) => n.classList.remove("drop-before", "drop-target"));
    const { groupId, beforeId, noop } = where(e);
    if (noop) return;
    const groupDrag = e.dataTransfer.getData("application/x-tab-shelf-group");
    if (groupDrag) {
      if (groupDrag !== groupId) await op("reorderGroup", groupDrag, groupId);
      return;
    }
    const raw = e.dataTransfer.getData(DND_TYPE);
    if (raw) {
      const ids = JSON.parse(raw).filter((id) => id !== beforeId);
      await send("moveTabs", { ids, groupId, beforeId });
      if (ids.length > 1 || state.tabs[ids[0]]?.groupId !== groupId) toast(`Moved ${ids.length} tab${ids.length === 1 ? "" : "s"} to ${state.groups[groupId].name}`);
      return;
    }
    // A link or tab dragged in from the browser itself.
    const url = (e.dataTransfer.getData("text/uri-list") || "").split(/\r?\n/).find((l) => l && !l.startsWith("#"));
    if (url) {
      const r = await send("saveUrl", { url, title: e.dataTransfer.getData("text/x-moz-url")?.split("\n")[1] || url, groupId });
      toast(r.added ? "Saved" : "Already saved");
    }
  });
}

// ------------------------------------------------------------------ actions

function renameGroup(g, h2) {
  const input = el("input", { type: "text", value: g.name, "aria-label": "Group name" });
  const done = async (save) => {
    input.removeEventListener("blur", onBlur);
    input.blur(); // lets the pending re-render run
    if (save && input.value.trim() && input.value.trim() !== g.name) await op("updateGroup", g.id, { name: input.value.trim() });
    else render();
  };
  const onBlur = () => done(true);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") done(true);
    if (e.key === "Escape") done(false);
  });
  input.addEventListener("blur", onBlur);
  h2.replaceChildren(input);
  input.select();
}

async function deleteGroup(g, count) {
  const what = g.id === INBOX_ID ? `Empty the Inbox (${count} tabs)?` : `Delete "${g.name}" and its ${count} tab${count === 1 ? "" : "s"}?`;
  if (count && !confirm(what)) return;
  await op("deleteGroup", g.id);
  if (activeGroup === g.id) activeGroup = "";
}

function editTags(t, box) {
  const input = el("input", { type: "text", class: "tag-edit", value: t.tags.join(", "), placeholder: "comma, separated, tags" });
  let finished = false;
  const done = async (save) => {
    if (finished) return;
    finished = true;
    input.blur();
    if (save) await op("setTags", t.id, input.value.split(","));
    else render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") done(true);
    if (e.key === "Escape") done(false);
  });
  input.addEventListener("blur", () => done(true));
  box.replaceChildren(input);
  input.focus();
}

let lastClicked = null;
function toggleSelect(id, e) {
  if (e.shiftKey && lastClicked) {
    const rows = [...document.querySelectorAll(".tab")].map((n) => n.dataset.id);
    const [a, b] = [rows.indexOf(lastClicked), rows.indexOf(id)].sort((x, y) => x - y);
    if (a >= 0) rows.slice(a, b + 1).forEach((x) => selected.add(x));
  } else if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  lastClicked = id;
  render();
}

function renderSelbar() {
  $("selbar").hidden = selected.size === 0;
  $("sel-count").textContent = `${selected.size} selected`;
  $("sel-move").replaceChildren(
    el("option", { value: "" }, "Move to…"),
    ...sortedGroups(state).map((g) => el("option", { value: g.id }, g.name)),
    el("option", { value: "__new" }, "＋ New group…"),
  );
}

$("sel-move").addEventListener("change", async (e) => {
  let groupId = e.target.value;
  if (!groupId) return;
  if (groupId === "__new") {
    const name = prompt("New group name");
    if (!name) return render();
    groupId = (await op("addGroup", name)).id;
  }
  await send("moveTabs", { ids: [...selected], groupId });
  toast(`Moved ${selected.size} tabs`);
  selected.clear();
  render();
});
$("sel-tag").addEventListener("click", () => {
  $("tag-input").value = "";
  $("tag-dialog").showModal();
});
$("tag-dialog").addEventListener("close", async () => {
  if ($("tag-dialog").returnValue === "cancel") return;
  const tags = $("tag-input").value.split(",").map((s) => s.trim()).filter(Boolean);
  if (tags.length) await send("tagTabs", { ids: [...selected], tags });
});
$("sel-ai").addEventListener("click", () => runAiTag([...selected], false));
$("sel-open").addEventListener("click", () => send("openTabs", { ids: [...selected] }));
$("sel-delete").addEventListener("click", async () => {
  if (!confirm(`Delete ${selected.size} saved tab${selected.size === 1 ? "" : "s"}?`)) return;
  await send("deleteTabs", { ids: [...selected] });
  selected.clear();
});
$("sel-clear").addEventListener("click", () => {
  selected.clear();
  render();
});

async function runAiTag(ids, onlyUntagged) {
  const btn = $("ai-tag");
  btn.disabled = true;
  btn.textContent = "Tagging…";
  try {
    const r = await send("aiTag", { ids, onlyUntagged });
    toast(r.tagged ? `Tagged ${r.tagged} tab${r.tagged === 1 ? "" : "s"}` : "Nothing to tag");
  } catch (e) {
    toast(String(e.message || e).replace(/^Error: /, ""), 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = "AI tag";
  }
}

$("ai-tag").addEventListener("click", () => runAiTag(activeGroup ? tabsInGroup(state, activeGroup).map((t) => t.id) : undefined, true));

$("add-group").addEventListener("click", async () => {
  const name = prompt("New group name");
  if (!name) return;
  const g = await op("addGroup", name);
  activeGroup = g.id;
});

$("nav-all").addEventListener("click", () => {
  activeGroup = "";
  render();
});

// search
let searchTimer;
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    history.replaceState(null, "", $("q").value ? "#" + encodeURIComponent($("q").value) : location.pathname);
    render();
  }, 80);
}
$("q").addEventListener("input", onSearch);
document.addEventListener("keydown", (e) => {
  if ((e.key === "/" || (e.key === "f" && (e.ctrlKey || e.metaKey))) && !e.target.matches("input, textarea")) {
    e.preventDefault();
    $("q").focus();
    $("q").select();
  }
  if (e.key === "Escape" && document.activeElement === $("q")) {
    $("q").value = "";
    onSearch();
  }
});

// export
$("export").addEventListener("click", (e) => {
  e.stopPropagation();
  $("export-menu").hidden = !$("export-menu").hidden;
});
document.addEventListener("click", () => ($("export-menu").hidden = true));
$("export-menu").addEventListener("click", async (e) => {
  const format = e.target.dataset.format;
  if (!format) return;
  const text = await send("export", { format });
  const ext = { json: "json", html: "html", onetab: "txt" }[format];
  const type = { json: "application/json", html: "text/html", onetab: "text/plain" }[format];
  const a = el("a", {
    href: URL.createObjectURL(new Blob([text], { type })),
    download: `tab-shelf-${new Date().toISOString().slice(0, 10)}.${ext}`,
  });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

// import
$("import").addEventListener("click", async () => {
  $("import-text").value = "";
  $("import-file").value = "";
  const { settings } = await browser.storage.local.get("settings");
  $("import-ai").checked = !!settings?.ai?.apiKey && settings?.ai?.autoTag !== false;
  $("import-ai").disabled = !settings?.ai?.apiKey;
  $("import-dialog").showModal();
});
$("import-file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (f) $("import-text").value = await f.text();
});
$("import-dialog").addEventListener("close", async () => {
  if ($("import-dialog").returnValue === "cancel") return;
  const text = $("import-text").value;
  if (!text.trim()) return;
  try {
    const r = await send("import", { text, autoTag: $("import-ai").checked });
    toast(`Imported ${r.added} tab${r.added === 1 ? "" : "s"}${r.skipped ? `, skipped ${r.skipped} duplicate or invalid` : ""}`, 5000);
  } catch (err) {
    toast("Import failed: " + (err.message || err), 6000);
  }
});

// duplicates
$("dupes").addEventListener("click", () => {
  const sets = findDuplicates(state);
  const extra = sets.reduce((n, s) => n + s.length - 1, 0);
  $("dupes-summary").textContent = sets.length
    ? `${extra} duplicate${extra === 1 ? "" : "s"} across ${sets.length} URL${sets.length === 1 ? "" : "s"}. The oldest copy is kept and tags are merged into it.`
    : "No duplicates. Nice and tidy.";
  $("dupes-list").replaceChildren(
    ...sets.slice(0, 200).map((ids) => {
      const t = state.tabs[ids[0]];
      const where = [...new Set(ids.map((id) => state.groups[state.tabs[id].groupId]?.name))].join(", ");
      return el("li", {}, `${t.title} `, el("span", { class: "muted" }, `×${ids.length} in ${where}`));
    }),
  );
  $("dupes-go").hidden = !sets.length;
  $("dupes-dialog").showModal();
});
$("dupes-dialog").addEventListener("close", async () => {
  if ($("dupes-dialog").returnValue === "cancel" || $("dupes-go").hidden) return;
  const n = await op("removeDuplicates");
  toast(`Removed ${n} duplicate${n === 1 ? "" : "s"}`);
});

// settings / welcome
$("settings").addEventListener("click", () => browser.runtime.openOptionsPage());
$("welcome-options").addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
});
$("welcome-close").addEventListener("click", () => {
  $("welcome").hidden = true;
  if (location.hash === "#welcome") history.replaceState(null, "", location.pathname);
});

// Hash: "#welcome" shows the intro; anything else is a search (or a URL to
// highlight, used by the address-bar icon for already-saved pages).
function readHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h === "welcome") {
    $("welcome").hidden = false;
    return;
  }
  if (/^[a-z]+:\/\//i.test(h)) {
    $("q").value = "";
    render();
    const t = Object.values(state.tabs).find((x) => x.url === h);
    const row = t && document.querySelector(`.tab[data-id="${CSS.escape(t.id)}"]`);
    if (row) {
      row.scrollIntoView({ block: "center" });
      row.classList.add("highlight");
    }
    history.replaceState(null, "", location.pathname);
    return;
  }
  $("q").value = h;
  render();
}
window.addEventListener("hashchange", readHash);

applyTheme();
load().then(readHash);
