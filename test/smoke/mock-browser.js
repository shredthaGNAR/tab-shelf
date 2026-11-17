// Minimal in-page mock of the WebExtension APIs used by Tab Shelf, so the
// pages and background script can be smoke-tested in Chromium.
(() => {
  const ev = () => { const ls = []; return { addListener: (f) => ls.push(f), removeListener() {}, _fire: (...a) => ls.map((f) => f(...a)), _ls: ls }; };
  const area = (name) => {
    let data = {};
    return {
      _data: () => data,
      async get(keys) {
        if (keys == null) return structuredClone(data);
        const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        for (const k of ks) if (k in data) out[k] = structuredClone(data[k]);
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: data[k], newValue: structuredClone(v) }; data[k] = structuredClone(v); }
        setTimeout(() => storageChanged._fire(changes, name));
      },
      async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
    };
  };
  const storageChanged = ev();
  const onMessage = ev();
  let nextTab = 100;
  const tabs = [
    { id: 1, windowId: 1, url: "https://developer.mozilla.org/en-US/docs/Web/API", title: "Web APIs | MDN", active: true, highlighted: true, pinned: false, favIconUrl: "" },
    { id: 2, windowId: 1, url: "https://github.com/mozilla/web-ext", title: "mozilla/web-ext: A command line tool", active: false, highlighted: false, pinned: false },
    { id: 3, windowId: 1, url: "https://www.seriouseats.com/pasta?utm_source=x", title: "Pasta recipes", active: false, highlighted: false, pinned: false },
  ];
  window.__opened = [];
  window.browser = {
    storage: { local: area("local"), sync: area("sync"), onChanged: storageChanged },
    runtime: {
      getURL: (p) => location.origin + "/src/" + p,
      onMessage,
      async sendMessage(msg) {
        const rs = onMessage._ls.map((f) => f(msg)).filter((r) => r !== undefined);
        return rs.length ? await rs[0] : undefined;
      },
      onInstalled: ev(), onStartup: ev(),
      openOptionsPage: async () => window.__opened.push("options"),
    },
    tabs: {
      async query(q) {
        return tabs.filter((t) => (q.active == null || t.active === q.active) && (q.highlighted == null || t.highlighted === q.highlighted) && (!q.url || t.url.startsWith(q.url.replace("*", ""))));
      },
      async create(p) { window.__opened.push(p.url); const t = { id: nextTab++, windowId: 1, ...p }; return t; },
      async update(id, p) { return { id, ...p }; },
      async remove(ids) { for (const id of [].concat(ids)) { const i = tabs.findIndex((t) => t.id === id); if (i >= 0) tabs.splice(i, 1); } },
      async get(id) { return tabs.find((t) => t.id === id); },
      onActivated: ev(), onUpdated: ev(),
    },
    windows: { create: async (p) => (window.__opened.push(p.url), { id: 2 }), update: async () => {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    pageAction: { setIcon: async () => {}, setTitle: async () => {}, onClicked: ev() },
    menus: { create() {}, removeAll: async () => {}, onClicked: ev() },
    commands: { onCommand: ev() },
    permissions: { request: async () => true },
  };
  window.__tabs = tabs;
})();
