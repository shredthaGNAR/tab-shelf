// Thin wrapper over browser.storage.local. Only the background script writes
// state (through mutate) so writes are serialised; pages read and listen.

import { ensureValid, emptyState } from "./ops.js";
import { DEFAULT_AI } from "./ai.js";

export const STATE_KEY = "state";
export const SETTINGS_KEY = "settings";
export const STATUS_KEY = "status";

export const DEFAULT_SETTINGS = {
  defaultGroupId: "inbox",
  closeAfterSave: false,
  skipDuplicates: true,
  removeOnRestore: false,
  restoreInNewWindow: false,
  syncEnabled: true,
  theme: "auto",
  ai: { ...DEFAULT_AI },
};

export async function loadState() {
  const r = await browser.storage.local.get(STATE_KEY);
  return ensureValid(r[STATE_KEY] || emptyState());
}

export async function saveState(state) {
  await browser.storage.local.set({ [STATE_KEY]: state });
}

let queue = Promise.resolve();

// Run fn(state) and persist the result. Calls are queued so that concurrent
// mutations never overwrite each other.
export function mutate(fn) {
  const run = queue.then(async () => {
    const state = await loadState();
    const result = await fn(state);
    await saveState(state);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

export async function loadSettings() {
  const r = await browser.storage.local.get(SETTINGS_KEY);
  const s = r[SETTINGS_KEY] || {};
  return { ...DEFAULT_SETTINGS, ...s, ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai || {}) } };
}

export async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = { ...cur, ...patch, ai: { ...cur.ai, ...(patch.ai || {}) } };
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function setStatus(patch) {
  const r = await browser.storage.local.get(STATUS_KEY);
  await browser.storage.local.set({ [STATUS_KEY]: { ...(r[STATUS_KEY] || {}), ...patch } });
}

export async function getStatus() {
  return (await browser.storage.local.get(STATUS_KEY))[STATUS_KEY] || {};
}
