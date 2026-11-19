import { test } from "node:test";
import assert from "node:assert/strict";
import * as ops from "../src/lib/ops.js";

test("normalizeUrl ignores tracking params, hash, www and trailing slash", () => {
  assert.equal(ops.normalizeUrl("https://www.Example.com/a/?utm_source=x&b=2&a=1#top"), ops.normalizeUrl("http://example.com/a?a=1&b=2"));
  assert.notEqual(ops.normalizeUrl("https://example.com/a?id=1"), ops.normalizeUrl("https://example.com/a?id=2"));
});

test("addTabs skips duplicates and invalid urls", () => {
  const s = ops.emptyState();
  const a = ops.addTabs(s, ops.INBOX_ID, [{ url: "https://a.com/", title: "A" }, { url: "about:blank" }, { url: "https://www.a.com" }]);
  assert.equal(a.length, 1);
  const b = ops.addTabs(s, ops.INBOX_ID, [{ url: "https://a.com/#x" }], { skipDuplicates: false });
  assert.equal(b.length, 1);
  assert.equal(ops.findDuplicates(s).length, 1);
});

test("removeDuplicates keeps oldest and merges tags", () => {
  const s = ops.emptyState();
  ops.addTabs(s, ops.INBOX_ID, [{ url: "https://a.com", tags: ["x"], savedAt: 1 }]);
  const g = ops.addGroup(s, "Work");
  ops.addTabs(s, g.id, [{ url: "https://a.com/?utm_medium=m", tags: ["y"], savedAt: 2 }], { skipDuplicates: false });
  assert.equal(ops.removeDuplicates(s), 1);
  const [t] = Object.values(s.tabs);
  assert.equal(t.savedAt, 1);
  assert.deepEqual(t.tags.sort(), ["x", "y"]);
});

test("moveTab reorders across groups", () => {
  const s = ops.emptyState();
  const g = ops.addGroup(s, "G");
  const [a, b, c] = ops.addTabs(s, ops.INBOX_ID, ["a", "b", "c"].map((x) => ({ url: `https://${x}.com` })));
  ops.moveTab(s, c.id, ops.INBOX_ID, a.id);
  assert.deepEqual(ops.tabsInGroup(s, ops.INBOX_ID).map((t) => t.id), [c.id, a.id, b.id]);
  ops.moveTab(s, a.id, g.id);
  assert.deepEqual(ops.tabsInGroup(s, g.id).map((t) => t.id), [a.id]);
  assert.equal(ops.tabsInGroup(s, ops.INBOX_ID).length, 2);
});

test("search supports words, tag:, group:, site: and exclusions", () => {
  const s = ops.emptyState();
  const g = ops.addGroup(s, "Cooking");
  ops.addTabs(s, g.id, [{ url: "https://food.com/pasta", title: "Best pasta", tags: ["recipes"] }]);
  ops.addTabs(s, ops.INBOX_ID, [{ url: "https://github.com/x", title: "Repo pasta" }]);
  assert.equal(ops.search(s, "pasta").length, 2);
  assert.equal(ops.search(s, "pasta tag:recipes").length, 1);
  assert.equal(ops.search(s, "#recipes").length, 1);
  assert.equal(ops.search(s, "group:cook").length, 1);
  assert.equal(ops.search(s, "site:github").length, 1);
  assert.equal(ops.search(s, "pasta -repo").length, 1);
  assert.equal(ops.search(s, '"best pasta"').length, 1);
});

test("deleteGroup removes its tabs; inbox survives", () => {
  const s = ops.emptyState();
  const g = ops.addGroup(s, "G");
  ops.addTabs(s, g.id, [{ url: "https://a.com" }]);
  ops.addTabs(s, ops.INBOX_ID, [{ url: "https://b.com" }]);
  ops.deleteGroup(s, g.id);
  ops.deleteGroup(s, ops.INBOX_ID);
  assert.equal(Object.keys(s.tabs).length, 0);
  assert.ok(s.groups[ops.INBOX_ID]);
  assert.ok(!s.groups[g.id]);
});

test("merge: newest wins, tombstones delete, missing records survive", () => {
  const base = ops.emptyState(100);
  const [t] = ops.addTabs(base, ops.INBOX_ID, [{ url: "https://a.com", title: "A" }], { now: 100 });
  const local = ops.clone(base);
  const remote = ops.clone(base);
  local.tabs[t.id].title = "Local";
  local.tabs[t.id].updatedAt = 200;
  remote.tabs[t.id].title = "Remote";
  remote.tabs[t.id].updatedAt = 300;
  ops.addTabs(local, ops.INBOX_ID, [{ url: "https://only-local.com" }], { now: 150 });
  const m = ops.merge(local, remote, 400);
  assert.equal(m.tabs[t.id].title, "Remote");
  assert.equal(Object.keys(m.tabs).length, 2);
  ops.deleteTab(remote, t.id, 350);
  const m2 = ops.merge(local, remote, 400);
  assert.ok(!m2.tabs[t.id]);
  // merge is commutative in content
  assert.equal(ops.fingerprint(ops.merge(local, remote, 400)), ops.fingerprint(ops.merge(remote, local, 400)));
});
