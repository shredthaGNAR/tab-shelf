import { test } from "node:test";
import assert from "node:assert/strict";
import * as ops from "../src/lib/ops.js";
import { pack, unpack, chunkString, staleKeys } from "../src/lib/syncpack.js";

const enc = new TextEncoder();

test("pack/unpack round trip and every item fits under 8 KB", () => {
  const s = ops.emptyState();
  const g = ops.addGroup(s, "Ünïcödé 🎉");
  ops.addTabs(s, g.id, Array.from({ length: 300 }, (_, i) => ({ url: `https://example.com/page/${i}`, title: `日本語のタイトル ${i} 🎉`, tags: ["a", "b"] })));
  const { items, meta } = pack(s, "dev");
  for (const [k, v] of Object.entries(items)) assert.ok(enc.encode(k + JSON.stringify(v)).length <= 8192, k);
  assert.equal(meta.partial, false);
  const back = unpack(items).state;
  assert.equal(Object.keys(back.tabs).length, 300);
  assert.equal(ops.fingerprint(back), ops.fingerprint(s));
});

test("oversized state is trimmed to fit the 100 KB quota", () => {
  const s = ops.emptyState();
  ops.addTabs(s, ops.INBOX_ID, Array.from({ length: 4000 }, (_, i) => ({ url: `https://example.com/a/very/long/path/${i}?q=${"x".repeat(40)}`, title: "T".repeat(200) })));
  const { items, meta } = pack(s);
  const total = Object.entries(items).reduce((n, [k, v]) => n + enc.encode(k + JSON.stringify(v)).length, 0);
  assert.ok(total < 102400, `total ${total}`);
  assert.ok(meta.partial);
  assert.ok(meta.synced > 0 && meta.synced < 4000);
  assert.equal(Object.keys(unpack(items).state.tabs).length, meta.synced);
});

test("incomplete chunk sets are ignored and stale keys found", () => {
  const s = ops.emptyState();
  ops.addTabs(s, ops.INBOX_ID, [{ url: "https://a.com" }]);
  const { items, meta } = pack(s);
  assert.equal(unpack({ meta: { chunks: 2 }, c0: items.c0 }), null);
  assert.deepEqual(staleKeys({ c0: "", c1: "", c5: "", meta: {} }, meta), ["c1", "c5"]);
});

test("chunkString never splits surrogate pairs", () => {
  const str = "🎉".repeat(5000);
  const parts = chunkString(str, 1000);
  assert.equal(parts.join(""), str);
  for (const p of parts) assert.ok(!/[\uD800-\uDBFF]$/.test(p));
});
