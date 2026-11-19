// Smoke test: serves the repo, loads each page with the mock API plus the
// background script, exercises the main flows and takes screenshots.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright"); // preinstalled globally or as a devDependency
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const out = process.argv[2] || path.join(root, "test/smoke/out");
fs.mkdirSync(out, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": types[path.extname(p)] || "application/octet-stream" }).end(fs.readFileSync(p));
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const mock = fs.readFileSync(path.join(root, "test/smoke/mock-browser.js"), "utf8");

const browser = await chromium.launch();
const errors = [];
async function open(page, file, { width = 1200, height = 800, scheme = "light" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${file}: ${e.message}`));
  p.on("console", (m) => m.type() === "error" && errors.push(`${file}: ${m.text()}`));
  p.on("dialog", (d) => d.accept(d.type() === "prompt" ? "Research" : undefined));
  await p.addInitScript(mock);
  // Run the real background script in the same page so messages reach it.
  await p.addInitScript(`window.__bg = import("${base}/src/background.js").then(() => browser.runtime.onInstalled._fire({ reason: "update" }));`);
  await p.goto(`${base}/src/${file}`);
  await p.evaluate(() => window.__bg);
  await p.waitForTimeout(200);
  return p;
}
const check = (cond, msg) => { if (!cond) { errors.push("FAIL: " + msg); console.log("FAIL -", msg); } else console.log("ok -", msg); };

// ---- popup: save flows
let p = await open(null, "popup/popup.html", { width: 380, height: 560 });
await p.click("#save-tab");
await p.waitForTimeout(300);
let st = await p.evaluate(() => browser.storage.local._data().state);
check(Object.keys(st.tabs).length === 1, "popup saves the current tab");
await p.click("#save-window");
await p.waitForTimeout(300);
st = await p.evaluate(() => browser.storage.local._data().state);
check(Object.keys(st.tabs).length === 3, "save window adds the other 2 tabs, skips the duplicate");
await p.evaluate(() => browser.storage.local.set({ settings: { skipDuplicates: false } }));
await p.evaluate(() => browser.commands.onCommand._fire("save-window"));
await p.waitForTimeout(300);
st = await p.evaluate(() => browser.storage.local._data().state);
const session = Object.values(st.groups).find((g) => g.name.startsWith("Session"));
check(session && Object.values(st.tabs).filter((t) => t.groupId === session.id).length === 3, "Alt+Shift+W creates a session group with the window's tabs");
await p.evaluate((id) => browser.runtime.sendMessage({ cmd: "op", name: "deleteGroup", args: [id] }), session.id);
await p.evaluate(() => browser.storage.local.set({ settings: {} }));
await p.waitForTimeout(300);
st = await p.evaluate(() => browser.storage.local._data().state);
await p.fill("#q", "pasta");
await p.waitForTimeout(100);
check((await p.locator("#results li").count()) === 1, "popup search finds a tab");
await p.screenshot({ path: path.join(out, "popup.png") });
const saved = st;

// ---- manager: render, drag and drop, tags, dupes, export/import
p = await open(null, "manager/manager.html#welcome");
await p.evaluate((s) => browser.storage.local.set({ state: s }), saved);
await p.waitForTimeout(300);
check(await p.locator("#welcome").isVisible(), "welcome banner shows on first run");
check((await p.locator(".tab").count()) === 3, "manager lists 3 tabs");
// drag the pasta tab from the session to the Inbox via the sidebar
const pasta = Object.values(saved.tabs).find((t) => t.title === "Pasta recipes");
await p.dragAndDrop(`.tab[data-id="${pasta.id}"]`, `.nav-item[data-group="inbox"]`);
await p.waitForTimeout(300);
st = await p.evaluate(() => browser.storage.local._data().state);
check(st.tabs[pasta.id].groupId === "inbox", "drag tab onto sidebar group moves it");
// drag within the inbox: put pasta before the MDN tab
const mdn = Object.values(saved.tabs).find((t) => t.title.startsWith("Web APIs"));
await p.dragAndDrop(`.tab[data-id="${pasta.id}"]`, `.tab[data-id="${mdn.id}"]`);
await p.waitForTimeout(300);
st = await p.evaluate(() => browser.storage.local._data().state);
const inbox = Object.values(st.tabs).filter((t) => t.groupId === "inbox").sort((a, b) => a.order - b.order).map((t) => t.title);
check(inbox[0] === "Pasta recipes", "drag onto a tab reorders (" + inbox.join(", ") + ")");
// tags
await p.hover(`.tab[data-id="${pasta.id}"]`);
await p.click(`.tab[data-id="${pasta.id}"] button[title="Edit tags"]`);
await p.fill(`.tab[data-id="${pasta.id}"] .tag-edit`, "Recipes, food");
await p.press(`.tab[data-id="${pasta.id}"] .tag-edit`, "Enter");
await p.waitForTimeout(300);
st = await p.evaluate(() => browser.storage.local._data().state);
check(st.tabs[pasta.id].tags.join() === "recipes,food", "editing tags saves normalised tags");
await p.locator("#tag-cloud .tag", { hasText: "#recipes" }).click();
await p.waitForTimeout(200);
check((await p.locator(".tab").count()) === 1 && (await p.inputValue("#q")) === "tag:recipes", "tag cloud filters by tag");
await p.fill("#q", "");
await p.waitForTimeout(200);
// selection + move to new group
await p.click(`.tab[data-id="${mdn.id}"] input[type=checkbox]`);
await p.selectOption("#sel-move", "__new");
await p.waitForTimeout(400);
st = await p.evaluate(() => browser.storage.local._data().state);
check(st.groups[st.tabs[mdn.id].groupId].name === "Research", "move selection to a new group");
// duplicates
await p.evaluate(() => browser.runtime.sendMessage({ cmd: "import", text: "https://github.com/mozilla/web-ext/?utm_source=dup\nhttps://example.org" }));
await p.waitForTimeout(300);
st = await p.evaluate(() => browser.storage.local._data().state);
check(Object.keys(st.tabs).length === 4, "import adds new URL and skips the duplicate");
await p.evaluate(() => browser.runtime.sendMessage({ cmd: "saveSettings", patch: { skipDuplicates: false } }));
await p.evaluate(() => browser.runtime.sendMessage({ cmd: "import", text: "https://github.com/mozilla/web-ext/?utm_source=dup" }));
await p.waitForTimeout(300);
await p.click("#dupes");
check(/1 duplicate/.test(await p.textContent("#dupes-summary")), "duplicates dialog finds 1");
await p.click("#dupes-go");
await p.waitForTimeout(300);
st = await p.evaluate(() => browser.storage.local._data().state);
check(Object.keys(st.tabs).length === 4, "remove duplicates");
// sync pushed something
await p.waitForTimeout(4500);
const sync = await p.evaluate(() => browser.storage.sync._data());
check(sync.meta && sync.meta.chunks >= 1, "state is pushed to storage.sync");
await p.screenshot({ path: path.join(out, "manager.png"), fullPage: true });
const dark = await open(null, "manager/manager.html", { scheme: "dark" });
await dark.evaluate((s) => browser.storage.local.set({ state: s }), st);
await dark.waitForTimeout(300);
await dark.screenshot({ path: path.join(out, "manager-dark.png"), fullPage: true });
const phone = await open(null, "manager/manager.html", { width: 390, height: 844 });
await phone.evaluate((s) => browser.storage.local.set({ state: s }), st);
await phone.waitForTimeout(300);
const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
check(!overflow, "manager has no horizontal scroll at phone width");

// ---- sync: second device merges
const dev2 = await open(null, "manager/manager.html");
await dev2.evaluate((items) => browser.storage.sync.set(items), sync);
await dev2.evaluate(() => browser.runtime.sendMessage({ cmd: "syncNow" }));
await dev2.waitForTimeout(300);
const st2 = await dev2.evaluate(() => browser.storage.local._data().state);
check(Object.keys(st2.tabs).length === 4, "second device pulls tabs from sync");

// ---- options
p = await open(null, "options/options.html", { width: 900, height: 1100 });
await p.fill("#apiKey", "sk-test");
await p.click("#saveAi");
await p.waitForTimeout(300);
const settings = await p.evaluate(() => browser.storage.local._data().settings);
check(settings.ai.apiKey === "sk-test", "options saves API key locally");
check(!JSON.stringify(await p.evaluate(() => browser.storage.sync._data())).includes("sk-test"), "API key never reaches storage.sync");
await p.screenshot({ path: path.join(out, "options.png"), fullPage: true });

await browser.close();
server.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("smoke test passed");
