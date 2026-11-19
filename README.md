# Tab Shelf

A Firefox (Nightly-friendly, Manifest V3) extension for saving tabs and whole sessions for later.

- **Groups.** Save into any group, or save a whole window as a dated "Session" group. Rename, recolour, reorder (drag in the sidebar), restore or delete groups.
- **Drag and drop.** Drag saved tabs between groups, onto a group in the sidebar, or above another tab to reorder. Select several (Shift-click for a range) and drag them together. You can also drag a link or tab from Firefox onto a group to save it.
- **Find things fast.** Search title, URL, notes, tags and group names. Filters: `tag:recipes`, `#recipes`, `group:work`, `site:github`, `-exclude`, `"exact phrase"`. Tag cloud in the sidebar. Press `/` to jump to search.
- **Duplicate removal.** Duplicates are skipped on save (tracking params, `www.`, `#fragments` and trailing slashes are ignored). The Duplicates button cleans up existing ones and merges their tags.
- **Address bar icon.** A shelf icon in the urlbar saves the page in one click. It turns blue when the page is already saved, and clicking it then shows the page in the manager.
- **Keyboard shortcuts.** `Alt+Shift+S` save tab (or all selected tabs), `Alt+Shift+W` save window as session, `Alt+Shift+M` open manager, `Alt+Shift+T` open popup. Change them at `about:addons` › ⚙ › *Manage Extension Shortcuts*.
- **Context menus.** Right-click a page, link or tab to save it.
- **Import / export.** Tab Shelf JSON (full backup), bookmarks HTML (import into/export from any browser), OneTab text, or any pasted list of URLs.
- **Firefox Sync.** Uses `storage.sync`, so it rides on your Firefox account with no extra server.
- **AI tagging.** Tags tabs with an OpenAI-compatible chat API using your own key, automatically on save or on demand.

## Install in Firefox Nightly

1. Download or clone this repo.
2. Open `about:debugging#/runtime/this-firefox` and click **Load Temporary Add-on…**.
3. Pick `src/manifest.json`.

Temporary add-ons are removed when Firefox restarts. To keep it installed in Nightly (or Developer Edition):

1. In `about:config`, set `xpinstall.signatures.required` to `false`.
2. Run `npm install && npm run build` to make `dist/tab_shelf-0.1.0.zip`.
3. Open `about:addons`, click ⚙ › **Install Add-on From File…**, and pick the zip.

Or run `npm start` to launch Nightly with the extension loaded via `web-ext`.

After installing, the urlbar icon may sit behind the `…` page actions menu. Right-click it there and choose **Pin to Address Bar**.

## Sync

Tab Shelf keeps everything in `storage.local` on each device and mirrors a compact copy into `storage.sync`. Changes merge record by record (the newest edit wins; deletions are carried as tombstones), so two devices editing at once do not clobber each other.

To turn it on, sign in to Firefox and make sure **Add-ons** is ticked in Settings › Sync on every device. Note that the add-on ID has to stay the same across devices for Firefox to sync its data, so install the same build everywhere.

Firefox gives extensions about 100 KB of sync space (8 KB per item). That holds roughly 600 to 1,500 tabs, depending on URL and title length. If you save more, titles are shortened first, then only the most recently changed tabs are synced. The rest stay on the device that has them, and the sidebar footer says how many fit. Favicons are not synced.

## AI tagging

Open the extension's settings, paste your OpenAI API key, and click **Save AI settings**. Firefox asks once for permission to reach the API host. **Test** checks the key works.

- Model defaults to `gpt-5-mini`. Change it to any chat model your account has.
- **API base URL** lets you point at any OpenAI-compatible service, for example OpenRouter, Azure OpenAI, or a local Ollama (`http://localhost:11434/v1`) or LM Studio server.
- Only each tab's title and URL are sent, 20 tabs per request. Existing tags are sent too so the model reuses your vocabulary.
- The key is stored in `storage.local` on this device only. It is never synced, never exported, and never committed.

Use **AI tag** in the manager to tag everything untagged (or everything in the selected group), or select tabs and use **AI tag** in the selection bar.

## Development

```
npm install
npm test            # unit tests for the data model, sync packing, import/export and AI client
npm run lint        # web-ext lint
npm start           # run in Firefox Nightly with live reload
npm run build       # zip for installing
node test/smoke/run.mjs   # loads the real pages in Chromium with a mocked browser API and clicks through the main flows
```

Layout:

```
src/
  manifest.json
  background.js      saving, restoring, menus, shortcuts, page action, sync, AI queue
  lib/ops.js         pure data model: groups, tabs, duplicates, search, merge
  lib/syncpack.js    packs state into storage.sync-sized chunks
  lib/io.js          import/export formats
  lib/ai.js          OpenAI-compatible tagging client
  lib/store.js       storage.local wrapper with a serialised write queue
  popup/  manager/  options/  ui/
```

Only the background script writes state. Pages send it messages and re-render on `storage.onChanged`.

## Publishing note

The manifest declares `data_collection_permissions: none`, which is right while AI tagging is off. AI tagging sends titles and URLs to the service you configure. Before listing on addons.mozilla.org, add `browsingActivity` as an optional data collection permission and request it when AI tagging is enabled.
