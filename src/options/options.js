import { ensureValid, sortedGroups } from "../lib/ops.js";
import { send, el, applyTheme, timeAgo } from "../ui/util.js";
import { DEFAULT_SETTINGS } from "../lib/store.js";

const $ = (id) => document.getElementById(id);
const CHECKS = ["closeAfterSave", "skipDuplicates", "restoreInNewWindow", "removeOnRestore", "syncEnabled"];

async function load() {
  const r = await browser.storage.local.get(["settings", "state", "status"]);
  const s = { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
  const ai = { ...DEFAULT_SETTINGS.ai, ...(s.ai || {}) };
  const state = ensureValid(r.state);
  for (const k of CHECKS) $(k).checked = !!s[k];
  $("defaultGroupId").replaceChildren(...sortedGroups(state).map((g) => el("option", { value: g.id }, g.name)));
  $("defaultGroupId").value = state.groups[s.defaultGroupId] ? s.defaultGroupId : "inbox";
  $("theme").value = s.theme || "auto";
  $("apiKey").value = ai.apiKey;
  $("model").value = ai.model;
  $("baseUrl").value = ai.baseUrl;
  $("maxTags").value = String(ai.maxTags);
  $("autoTag").checked = !!ai.autoTag;
  showSync(r.status || {});
}

function showSync(st) {
  const n = $("syncStatus");
  n.className = st.syncError ? "err" : "muted";
  n.textContent = st.syncError
    ? `Error: ${st.syncError}`
    : st.syncedAt
      ? `Last synced ${timeAgo(st.syncedAt)}${st.syncPartial ? ` · ${st.syncCount} of ${st.syncTotal} tabs fit` : ""}`
      : "Not synced yet";
}

const save = (patch) => send("saveSettings", { patch });

for (const k of CHECKS) $(k).addEventListener("change", (e) => save({ [k]: e.target.checked }));
$("defaultGroupId").addEventListener("change", (e) => save({ defaultGroupId: e.target.value }));
$("theme").addEventListener("change", async (e) => {
  await save({ theme: e.target.value });
  applyTheme();
});
$("autoTag").addEventListener("change", (e) => save({ ai: { autoTag: e.target.checked } }));
$("maxTags").addEventListener("change", (e) => save({ ai: { maxTags: Number(e.target.value) } }));

function aiForm() {
  return {
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim() || DEFAULT_SETTINGS.ai.model,
    baseUrl: ($("baseUrl").value.trim() || DEFAULT_SETTINGS.ai.baseUrl).replace(/\/+$/, ""),
    maxTags: Number($("maxTags").value),
    autoTag: $("autoTag").checked,
  };
}

// Ask Firefox for permission to reach the API host. Must run in a click handler.
async function ensureHostPermission(baseUrl) {
  let origin;
  try {
    const u = new URL(baseUrl);
    origin = `${u.protocol}//${u.hostname}/*`;
  } catch {
    throw new Error("The API base URL is not a valid URL");
  }
  const granted = await browser.permissions.request({ origins: [origin] });
  if (!granted) throw new Error(`Permission to reach ${origin} was declined`);
}

function aiMsg(text, cls = "muted") {
  $("aiStatus").className = cls;
  $("aiStatus").textContent = text;
}

$("saveAi").addEventListener("click", async () => {
  const ai = aiForm();
  try {
    await ensureHostPermission(ai.baseUrl);
    await save({ ai });
    aiMsg(ai.apiKey ? "Saved." : "Saved. AI tagging is off until you add a key.", "ok");
  } catch (e) {
    aiMsg(e.message, "err");
  }
});

$("testAi").addEventListener("click", async () => {
  const ai = aiForm();
  try {
    await ensureHostPermission(ai.baseUrl);
    aiMsg("Testing…");
    const tags = await send("testAI", { ai });
    aiMsg(`Works. Sample tags: ${tags.map((t) => "#" + t).join(" ")}`, "ok");
  } catch (e) {
    aiMsg(String(e.message || e).replace(/^Error: /, ""), "err");
  }
});

$("syncNow").addEventListener("click", async () => {
  $("syncStatus").textContent = "Syncing…";
  try {
    await send("syncNow");
  } catch {}
});

browser.storage.onChanged.addListener((c, area) => {
  if (area === "local" && c.status) showSync(c.status.newValue || {});
});

applyTheme();
load();
