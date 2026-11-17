import { search, sortedGroups, ensureValid, INBOX_ID } from "../lib/ops.js";
import { send, el, favicon, hostOf, applyTheme, toast } from "../ui/util.js";

const $ = (id) => document.getElementById(id);
let state;
let settings;

async function load() {
  const r = await browser.storage.local.get(["state", "settings"]);
  state = ensureValid(r.state);
  settings = r.settings || {};
  renderGroups();
  renderResults();
  $("close").checked = !!settings.closeAfterSave;
  const n = Object.keys(state.tabs).length;
  $("footer").textContent = `${n} saved tab${n === 1 ? "" : "s"} in ${Object.keys(state.groups).length} group${Object.keys(state.groups).length === 1 ? "" : "s"}`;
}

function renderGroups() {
  const sel = $("group");
  const cur = sel.value || settings.defaultGroupId || INBOX_ID;
  sel.replaceChildren(
    ...sortedGroups(state).map((g) => el("option", { value: g.id }, g.name)),
    el("option", { value: "new-session" }, "＋ New session (dated group)"),
    el("option", { value: "new-group" }, "＋ New group…"),
  );
  sel.value = state.groups[cur] || cur === "new-session" ? cur : INBOX_ID;
  $("newname").hidden = sel.value !== "new-group";
}

function renderResults() {
  const q = $("q").value.trim();
  const list = search(state, q).slice(0, q ? 50 : 8);
  $("results").replaceChildren(
    ...list.map((t) =>
      el("li", {},
        el("a", {
          href: t.url,
          title: t.url,
          onclick: (e) => {
            e.preventDefault();
            send("openTabs", { ids: [t.id], newWindow: e.shiftKey });
            window.close();
          },
        },
          favicon(t),
          el("span", { class: "r-text" },
            el("div", { class: "r-title" }, t.title),
            el("div", { class: "r-sub" }, `${state.groups[t.groupId]?.name} · ${hostOf(t.url)}${t.tags.length ? " · #" + t.tags.join(" #") : ""}`),
          ),
        ),
      ),
    ),
  );
  $("empty").hidden = list.length > 0;
  $("empty").textContent = q ? "No matches." : "Nothing saved yet. Save a tab above to get started.";
}

async function target() {
  const v = $("group").value;
  if (v === "new-group") {
    const name = $("newname").value.trim();
    if (!name) {
      $("newname").focus();
      toast("Type a name for the new group first");
      return null;
    }
    return { groupName: name };
  }
  return { groupId: v };
}

async function save(scope) {
  const t = await target();
  if (!t) return;
  const res = await send("saveTabs", { scope, ...t, close: $("close").checked });
  toast(res.added ? `Saved ${res.added} tab${res.added === 1 ? "" : "s"}${res.skipped ? ` (${res.skipped} already saved)` : ""}` : "Already saved");
  if ($("group").value !== "new-group" && $("group").value !== "new-session") {
    send("saveSettings", { patch: { defaultGroupId: $("group").value } });
  }
}

$("save-tab").addEventListener("click", () => save("selected"));
$("save-window").addEventListener("click", () => save("window"));
$("save-all").addEventListener("click", () => save("all"));
$("close").addEventListener("change", (e) => send("saveSettings", { patch: { closeAfterSave: e.target.checked } }));
$("q").addEventListener("input", renderResults);
$("group").addEventListener("change", () => {
  $("newname").hidden = $("group").value !== "new-group";
  if (!$("newname").hidden) $("newname").focus();
});
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const a = $("results").querySelector("a");
    if (a) a.click();
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    $("results").querySelector("a")?.focus();
  }
});
$("results").addEventListener("keydown", (e) => {
  const items = [...$("results").querySelectorAll("a")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown") items[i + 1]?.focus();
  if (e.key === "ArrowUp") (items[i - 1] || $("q")).focus();
  if (e.key.startsWith("Arrow")) e.preventDefault();
});
$("open-manager").addEventListener("click", () => {
  send("openManager", { query: $("q").value.trim() });
  window.close();
});
$("open-options").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});
browser.storage.onChanged.addListener((c, area) => {
  if (area === "local" && (c.state || c.settings)) load();
});

applyTheme();
load().then(() => $("q").focus());
