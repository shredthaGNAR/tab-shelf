import { test } from "node:test";
import assert from "node:assert/strict";
import * as ops from "../src/lib/ops.js";
import { detectFormat, parseImport, applyImport, exportJSON, exportHTML, exportOneTab } from "../src/lib/io.js";

function sample() {
  const s = ops.emptyState();
  const g = ops.addGroup(s, "Read <later> & \"stuff\"");
  ops.addTabs(s, g.id, [
    { url: "https://a.com/x?y=1&z=2", title: "A & B", tags: ["one", "two"] },
    { url: "https://b.com", title: "B" },
  ]);
  ops.addTabs(s, ops.INBOX_ID, [{ url: "https://c.com", title: "C" }]);
  return s;
}

for (const [name, fn, fmt] of [["json", exportJSON, "json"], ["html", exportHTML, "html"], ["onetab", exportOneTab, "onetab"]]) {
  test(`${name} export round-trips`, () => {
    const text = fn(sample());
    assert.equal(detectFormat(text), fmt);
    const s = ops.emptyState();
    const r = applyImport(s, parseImport(text));
    assert.equal(r.added, 3);
    const urls = Object.values(s.tabs).map((t) => t.url).sort();
    assert.deepEqual(urls, ["https://a.com/x?y=1&z=2", "https://b.com", "https://c.com"]);
    if (fmt !== "onetab") {
      assert.ok(ops.findGroupByName(s, 'Read <later> & "stuff"'));
      const a = Object.values(s.tabs).find((t) => t.url.startsWith("https://a.com"));
      assert.equal(a.title, "A & B");
      assert.deepEqual(a.tags, ["one", "two"]);
    }
  });
}

test("importing twice skips duplicates", () => {
  const s = ops.emptyState();
  const text = exportJSON(sample());
  applyImport(s, parseImport(text));
  const r = applyImport(s, parseImport(text));
  assert.equal(r.added, 0);
  assert.equal(r.skipped, 3);
});

test("nested bookmark folders flatten to group names", () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>
    <DT><H3>Dev</H3><DL><p>
      <DT><A HREF="https://mdn.dev">MDN</A>
      <DT><H3>JS</H3><DL><p><DT><A HREF="https://js.org">JS</A></DL><p>
    </DL><p></DL>`;
  const groups = parseImport(html);
  assert.deepEqual(groups.map((g) => g.name), ["Dev", "Dev / JS"]);
});

test("plain text URL list", () => {
  const g = parseImport("see https://a.com and\nhttp://b.org/x, ok");
  assert.equal(g[0].tabs.length, 2);
});
