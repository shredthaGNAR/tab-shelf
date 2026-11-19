// AI tagging through an OpenAI-compatible Chat Completions endpoint.
// The API key is supplied by the user in Options and kept in
// storage.local only (never synced, never bundled).

import { normalizeTags } from "./ops.js";

export const DEFAULT_AI = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5-mini",
  apiKey: "",
  autoTag: true,
  maxTags: 4,
};

const BATCH = 20;

export function buildMessages(tabs, vocabulary, maxTags) {
  const system =
    "You organise saved browser tabs. For each tab, choose 1 to " + maxTags +
    " short topical tags (lowercase, single words or hyphenated, e.g. \"javascript\", \"recipes\", \"machine-learning\"). " +
    "Prefer reusing tags from the existing vocabulary when they fit. Do not use generic tags like \"website\", \"article\" or \"link\". " +
    'Reply with JSON only: {"tags": {"<id>": ["tag", ...], ...}}';
  const user = JSON.stringify({
    existing_vocabulary: vocabulary.slice(0, 150),
    tabs: tabs.map((t) => ({ id: t.id, title: t.title.slice(0, 200), url: t.url.slice(0, 300) })),
  });
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function parseResponse(content, ids, maxTags) {
  let obj;
  try {
    obj = JSON.parse(content);
  } catch {
    const m = /\{[\s\S]*\}/.exec(content || "");
    if (!m) throw new Error("AI reply was not JSON");
    obj = JSON.parse(m[0]);
  }
  const map = obj.tags && typeof obj.tags === "object" ? obj.tags : obj;
  const out = {};
  for (const id of ids) {
    if (Array.isArray(map[id])) out[id] = normalizeTags(map[id]).slice(0, maxTags);
  }
  return out;
}

async function callOnce(cfg, tabs, vocabulary, fetchImpl) {
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: buildMessages(tabs, vocabulary, cfg.maxTags),
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const err = await res.json();
      if (err?.error?.message) msg += `: ${err.error.message}`;
    } catch {}
    throw new Error(`AI request failed (${msg})`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  return parseResponse(content, tabs.map((t) => t.id), cfg.maxTags);
}

// Returns { [tabId]: [tags] } for the given tabs.
export async function suggestTags(cfg, tabs, vocabulary = [], fetchImpl = fetch) {
  if (!cfg.apiKey) throw new Error("Add your OpenAI API key in Tab Shelf options first.");
  const out = {};
  for (let i = 0; i < tabs.length; i += BATCH) {
    Object.assign(out, await callOnce(cfg, tabs.slice(i, i + BATCH), vocabulary, fetchImpl));
  }
  return out;
}

export async function testConnection(cfg, fetchImpl = fetch) {
  const r = await suggestTags(cfg, [{ id: "t1", title: "MDN Web Docs: Array.prototype.map()", url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map" }], [], fetchImpl);
  return r.t1 || [];
}
