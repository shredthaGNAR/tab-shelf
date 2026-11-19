// Shared helpers for extension pages.

export const send = (cmd, data = {}) => browser.runtime.sendMessage({ cmd, ...data });
export const op = (name, ...args) => send("op", { name, args });

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "dataset") Object.assign(n.dataset, v);
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") for (const [p, val] of Object.entries(v)) n.style.setProperty(p.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), val);
    else if (v === true) n.setAttribute(k, "");
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c);
  return n;
}

const letterColors = ["#5b8def", "#e5484d", "#30a46c", "#f5a524", "#8e4ec6", "#12a594", "#e93d82"];

export function favicon(tab) {
  let host = "";
  try {
    host = new URL(tab.url).hostname.replace(/^www\./, "");
  } catch {}
  const fallback = () => {
    const s = el("span", { class: "favicon", "aria-hidden": "true" }, (host[0] || "?").toUpperCase());
    s.style.background = letterColors[[...host].reduce((a, c) => a + c.charCodeAt(0), 0) % letterColors.length];
    return s;
  };
  if (!tab.favIconUrl || !/^https?:/.test(tab.favIconUrl)) return fallback();
  const img = el("img", { class: "favicon", src: tab.favIconUrl, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
  img.addEventListener("error", () => img.replaceWith(fallback()), { once: true });
  return img;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

let toastTimer;
export function toast(msg, ms = 2600) {
  let t = document.querySelector(".toast");
  if (!t) document.body.append((t = el("div", { class: "toast", role: "status" })));
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

export async function applyTheme() {
  const { settings } = await browser.storage.local.get("settings");
  const theme = settings?.theme || "auto";
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
}
