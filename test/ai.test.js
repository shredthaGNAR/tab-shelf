import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestTags, parseResponse } from "../src/lib/ai.js";

test("parseResponse normalises tags and tolerates wrapping text", () => {
  const r = parseResponse('Here: {"tags": {"a": ["Machine Learning", "#AI", "ai"], "b": "bad"}}', ["a", "b"], 4);
  assert.deepEqual(r, { a: ["machine-learning", "ai"] });
});

test("suggestTags batches and sends key + model", async () => {
  const calls = [];
  const fake = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, model: body.model });
    const tabs = JSON.parse(body.messages[1].content).tabs;
    const tags = Object.fromEntries(tabs.map((t) => [t.id, ["x"]]));
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ tags }) } }] }) };
  };
  const tabs = Array.from({ length: 45 }, (_, i) => ({ id: "t" + i, title: "T", url: "https://x.com" }));
  const r = await suggestTags({ apiKey: "sk-test", baseUrl: "https://api.example.com/v1/", model: "m", maxTags: 3 }, tabs, [], fake);
  assert.equal(Object.keys(r).length, 45);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://api.example.com/v1/chat/completions");
  assert.equal(calls[0].auth, "Bearer sk-test");
});

test("suggestTags surfaces API errors and missing key", async () => {
  await assert.rejects(suggestTags({ apiKey: "" }, [{ id: "a", title: "", url: "" }]), /API key/);
  const fake = async () => ({ ok: false, status: 401, statusText: "Unauthorized", json: async () => ({ error: { message: "Incorrect API key" } }) });
  await assert.rejects(suggestTags({ apiKey: "k", baseUrl: "https://x", model: "m", maxTags: 2 }, [{ id: "a", title: "", url: "" }], [], fake), /401.*Incorrect API key/);
});
