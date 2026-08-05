# Manual Test Checklist

Run through this checklist before each release. Start from a clean state (`pnpm dev`) unless noted otherwise.

To fully reset the app (delete the database and start from onboarding):

```sh
rm "$(electron -e "console.log(require('electron').app.getPath('userData'))")/catena.db"
# or manually:
# macOS: rm ~/Library/Application\ Support/Catena/catena.db
# Windows: del %APPDATA%\Catena\catena.db
```

---

## 1. First Launch / Onboarding

### Welcome Step

- [ ] App opens to onboarding wizard (not the main app)
- [ ] Title "Welcome to Catena" and description are visible
- [ ] "Get started" button advances to provider step

### Provider Step -- Cohere

- [ ] "Use Cohere API" and "Use Ollama (Local)" buttons are shown
- [ ] Clicking "Use Cohere API" shows the API key form
- [ ] Back arrow returns to the provider choice
- [ ] Pasting an invalid key and submitting shows an error message
- [ ] Pasting a valid key shows a green success message and advances
- [ ] The "dashboard.cohere.com" link ("Get a free API key at …") opens in the default browser

### Ollama Engine Detection (run on both macOS and Windows)

Ollama's model store (`~/.ollama/models`, `%USERPROFILE%\.ollama\models`) is
shared between a user's own install and Catena's managed one, so models are never
duplicated. The engine binary is what Catena must avoid re-downloading.

- [ ] **Already running** → setup reuses it: no `downloading-engine` phase, no spawn. Quitting Catena leaves it running
- [ ] **Installed but NOT running** → setup starts the existing binary; still no `downloading-engine` phase - macOS: `/Applications/Ollama.app`, `/usr/local/bin/ollama`, `/opt/homebrew/bin/ollama` - Windows: `%LOCALAPPDATA%\Programs\Ollama\ollama.exe` - Console logs `Using the Ollama already installed at <path>`
- [ ] **Not installed at all** → downloads (~146 MB), extracts, starts
- [ ] After that download, **no `.tgz`/`.zip` remains** in `<userData>/ollama` — only the binary and its libraries
- [ ] Re-running setup with a managed binary present also clears any archive left by an older build
- [ ] With only a _user_ install and no managed binary, Settings shows Uninstall enabled only while the engine is up (`managedBinaryPresent` stays false — uninstall must never claim to remove someone else's install)

### Model Pulls Are Never Duplicated

- [ ] Pull `nomic-embed-text` yourself (`ollama pull nomic-embed-text`), then run Catena setup → **no pull happens**, setup completes immediately
- [ ] With no models present, setup pulls only the embedding model
- [ ] "Install a chat model" with `llama3.2` already present → completes instantly with no pull (works with networking off)
- [ ] With `llama3.2` absent, it pulls normally

### Uninstall Only Removes What Catena Pulled

- [ ] Pull `nomic-embed-text` yourself → set up Catena (reuses it) → Uninstall Ollama → **your model is still there** (`ollama list`)
- [ ] Let Catena pull both models → Uninstall → both are gone
- [ ] Mixed: you pulled the embed model, Catena pulled the chat model → Uninstall removes only `llama3.2`
- [ ] After any uninstall, `<userData>/ollama` is gone and a user's own install is untouched
- [ ] Upgrading from a build that predates this: the first uninstall still removes both defaults (no orphaned 2 GB store)

### Provider Step -- Ollama

- [ ] Clicking "Use Ollama (Local)" checks Ollama availability
- [ ] If Ollama is not running: shows install link and "Retry" button
- [ ] If Ollama is running but no embedding model: shows `ollama pull nomic-embed-text` instruction and "Retry"
- [ ] If Ollama is running with an embedding model: lists models and shows "Use Ollama" button
- [ ] Selecting Ollama advances to sources step

### Sources Step

- [ ] "Connect Notion" and "Connect Google Drive" buttons are visible
- [ ] "Skip for now" is always available
- [ ] After connecting a source, it appears in the "Connected" list
- [ ] "Continue" button appears once at least one source is connected
- [ ] Back arrow returns to provider step

### Done Step

- [ ] "You're all set!" message is shown
- [ ] Message varies depending on whether sources were connected
- [ ] "Start searching" button transitions to the main app

---

## 2. Navigation

- [ ] Sidebar shows three nav items: Search, Sources, Settings
- [ ] Clicking each nav item switches the visible page
- [ ] Active nav item is visually highlighted
- [ ] Page state is preserved when switching tabs (type a search query, switch to Sources, switch back -- query is still there)

---

## 3. Search

### Empty State

- [ ] Shows "Try searching your synced docs." with 4 example question cards
- [ ] Clicking an example card fills the input and triggers a search

### Search Input

- [ ] Input is auto-focused on mount
- [ ] Placeholder reads "Ask a question"
- [ ] Pressing Enter with text triggers search
- [ ] Pressing Enter with empty input does nothing
- [ ] Pressing Enter while loading does nothing
- [ ] Search icon changes to a spinner while loading

### Results

- [ ] Results display document title, snippet, provider badge, and match score
- [ ] "Open source" button opens the original document URL in the default browser
- [ ] Results are shown in relevance order (highest score first)
- [ ] Heading is shown on result cards when available

### Edge Cases

- [ ] Searching with no synced documents returns "No results found."
- [ ] Searching with a very long query does not crash
- [ ] Network failure during Cohere reranking shows "Reranking unavailable" warning but still returns results

### Embedding Health

- [ ] If documents were embedded with a different model than the current provider, a dismissible warning appears
- [ ] Dismissing the warning hides it for the session

### AI Answers — Elaborate

- [ ] An "Elaborate" checkbox sits beside **Generate answer**, unticked by default
- [ ] Tab reaches it as a single control named "Elaborate"; Space/Enter toggles it
- [ ] Generating with it unticked produces the usual short answer, and the answer card shows **no** badge
- [ ] Ticking it and generating produces a visibly longer answer, and the card shows an "Elaborate" badge next to the "Answer" heading
- [ ] The badge is present while the answer is still streaming, not only once it finishes
- [ ] Works on both providers (Cohere and Ollama) — the local model's answer lengthens too
- [ ] Toggling the box mid-stream does not change the badge on the answer already generating
- [ ] The box stays ticked across searches within a session (it is a preference, not a per-search reset)
- [ ] After a failure, **Try again** keeps the same Elaborate setting
- [ ] Restore an elaborated answer from Recents → the badge comes back with it
- [ ] Restore an answer generated **before** this feature shipped → no badge, no crash
- [ ] The question shown under the results ("Results for …") is unchanged — the word "Elaborate" never leaks into the query

### Recents

- [ ] Search with results appears under "Recents"; zero-result search does not
- [ ] Same query re-run (any casing/whitespace) → single entry moves to top, no duplicate
- [ ] Clicking a recent shows saved results instantly with the "Saved results from …" banner (works with Ollama stopped / offline)
- [ ] "Search again" re-runs live; banner disappears
- [ ] Provider stopped → recent still opens read-only, "Search again" disabled
- [ ] Hover reveals X; clicking removes the entry; section disappears when empty
- [ ] Clear all data empties Recents immediately
- [ ] Entry older than 7 days is gone after relaunch
- [ ] Long queries truncate with full text on hover; short window scrolls the list without pushing the logo out

---

## 4. Sources

### Connect Notion (OAuth)

- [ ] Clicking "Connect Notion" opens the Notion OAuth page in the default browser
- [ ] Completing OAuth in the browser returns focus to the app
- [ ] Browser shows "Connected to Notion! You can close this tab and return to Catena."
- [ ] App transitions to the Notion page picker (page list)

### Notion Page Picker

- [ ] Page list loads automatically after OAuth (spinner while loading)
- [ ] Pages granted during authorization are shown with emoji icon and title
- [ ] Pages without an emoji show a file icon
- [ ] Empty list shows "No pages found."
- [ ] Filter narrows the list (placeholder "Filter"); no matches shows "No results found."
- [ ] API error shows an error banner with a Retry button
- [ ] Checking pages updates the "Add {n} source(s)" button label
- [ ] "Add sources" creates the selected sources and refreshes the list
- [ ] "Close" returns to the idle state at any point

### Changing Which Notion Pages Catena Can Read

Catena is a **public** Notion connection, so the OAuth page picker is the only
way its page access can change — the per-page "Add connections" menu is for
internal connections and does not list Catena. That picker opens with **nothing
selected**, and the selection it returns becomes the _complete_ grant: any page
not re-ticked loses access. The UI exists to make that survivable, not to hide it.

- [ ] With Notion already connected, reopening the picker lists only the originally granted pages
- [ ] "Choose pages in Notion…" opens a warning dialog **before** any browser window
- [ ] The dialog states the selection is replaced, lists every connected Notion source by name, and suggests selecting a parent page
- [ ] "Cancel" closes the dialog and does NOT open the browser
- [ ] "Open Notion" opens the Notion consent page
- [ ] Re-ticking the listed pages plus a new one returns to the app and reloads the list with all of them
- [ ] The newly granted page can be added as a source and syncs
- [ ] A source added before the re-authorization still syncs afterwards (the token swap must not disturb it)
- [ ] "Cancel" during the wait returns to the list with no error banner, and the existing connection still works
- [ ] The button is also offered when the list is empty ("No pages found.")
- [ ] A re-authorization failure shows a banner but leaves the loaded page list intact

### Detecting Sources That Lost Access

- [ ] Deliberately re-authorize and tick ONLY a new page, dropping an existing source's page
- [ ] A warning names the dropped source(s) and says they will stop syncing
- [ ] The warning offers "Choose pages in Notion…" to go straight back and fix it
- [ ] Re-authorizing with every page ticked clears the warning
- [ ] Selecting a **parent** page and adding it as one source indexes the pages beneath it, and new pages added under it later are picked up by a normal sync with no re-authorization

### Switching Notion Workspaces (needs a second workspace)

- [ ] Re-authorizing into a different workspace while Notion sources exist shows "Switch Notion workspace?" naming both workspaces and the affected source count
- [ ] "Cancel" leaves the original connection intact — existing sources still sync
- [ ] "Switch anyway" commits the new workspace and reloads the page list
- [ ] Disconnecting Notion in Settings and reconnecting to a different workspace does NOT prompt (there is nothing left to orphan)

### Connect Google Drive (OAuth)

- [ ] Clicking "Connect Google Drive" opens the Google OAuth page in the default browser
- [ ] Completing OAuth in the browser returns focus to the app
- [ ] Browser shows "Connected to Google Drive! You can close this tab and return to Catena."
- [ ] App shows the Drive folder picker with the authenticated email

### Drive Folder Picker

- [ ] Folder contents load with breadcrumbs (root "My Drive"); navigating into a folder and back works
- [ ] 5+ levels deep: trail collapses to "My Drive › … › parent › current"; clicking "…" expands the full trail; long folder names truncate with the full name on hover
- [ ] Filter narrows the list (placeholder "Filter"); no matches shows "No results found."; an empty folder shows "This folder is empty."
- [ ] Checking folders updates the "Add {n} source(s)" button label
- [ ] "Add sources" creates the selected sources and refreshes the list

### Picking Up New Drive Content

Drive's scope is `drive.readonly` over the whole account, so new files are
already reachable by the existing token — nothing needs re-authorizing. What
hides them is the picker's in-memory folder cache.

- [ ] Add a folder in Drive while the picker is open, click "Refresh" → it appears
- [ ] Add a file to an already-synced folder, then Sync that source → the file is indexed (no reconnect needed)
- [ ] "Reconnect Google Drive" runs OAuth with **no** confirmation dialog first
- [ ] After reconnecting the same account, the listing reloads from My Drive and everything still syncs
- [ ] "Cancel" during the wait returns to the listing with no error banner
- [ ] A reconnect failure shows a banner but leaves the loaded listing intact
- [ ] Reconnecting as a **different** Google account shows a warning naming both accounts and the affected source count (does not block)

### Source List

- [ ] Connected sources show name, provider badge, and document count
- [ ] Empty state shows "No sources connected yet"

### Duplicate Source Prevention

- [ ] Adding the same Notion page or Drive folder twice shows "This source is already connected"

### Remove Source

- [ ] Clicking the trash icon shows a confirmation dialog
- [ ] Confirming removes the source and refreshes the list
- [ ] Canceling the dialog does nothing
- [ ] Removal failure shows a dismissible error banner

---

## 5. Sync

### Starting a Sync

- [ ] Clicking the sync (refresh) icon on a source opens the sync panel inline
- [ ] Sync panel shows "Syncing {name}" with a spinner

### Progress

- [ ] Phase label updates through: Fetching documents, Chunking text, Generating embeddings, Storing data
- [ ] Elapsed time counter increments
- [ ] Document count updates as documents are processed
- [ ] Current document title is shown

### Cancellation

- [ ] "Cancel" button stops the sync
- [ ] Panel shows "Sync canceled" with a "Canceled" footer and a "Dismiss" button
- [ ] Partial data from the sync is preserved

### Completion

- [ ] Panel shows "Sync complete", then auto-dismisses ("Dismissing…")
- [ ] Document count in the source list updates after the panel dismisses

### Error Handling

- [ ] Per-document errors show in a collapsible "N error(s)" details section
- [ ] Fatal sync errors show a red error message
- [ ] Attempting to sync the same source twice shows "Sync already in progress"

### Content Deduplication

- [ ] Syncing a source twice without changes skips unchanged documents (faster second sync)

---

## 6. Settings

### Embedding Provider Toggle

- [ ] Current provider button is filled; other is outlined
- [ ] Switching provider shows a confirmation dialog if chunks exist
- [ ] Canceling the dialog does nothing
- [ ] Confirming updates the provider setting

### Cohere API Key (when Cohere is selected)

- [ ] If a key exists: shows "Key configured" with masked dots
- [ ] "Remove" button shows confirmation dialog, then removes the key
- [ ] After removal: warning banner "No API key configured" appears
- [ ] Pasting a new key and clicking Save/Update validates against the Cohere API
- [ ] Invalid key shows an error message
- [ ] Valid key shows a success message (auto-dismisses after 3 seconds)

### Storage Stats

- [ ] Shows source count, document count, chunk count, and database size
- [ ] Values update after syncing or removing data
- [ ] Loading state shows skeleton placeholders

### Clear All Data

- [ ] "Clear all data" button shows a confirmation dialog
- [ ] Confirming clears all data and returns to the onboarding wizard
- [ ] Canceling does nothing

---

## 7. Accessibility

- [ ] `<html>` tag has `lang="en"` attribute
- [ ] Search input has `aria-label="Search your documents"`
- [ ] Error banners have `role="alert"`
- [ ] Drive folder input labels are associated with their inputs via `htmlFor`/`id`
- [ ] All interactive elements are keyboard-focusable
- [ ] Focus states are visible on all buttons and inputs

---

## 8. External Links

- [ ] "Open source" on a result card opens the URL in the default browser (not in the Electron window)
- [ ] The "dashboard.cohere.com" link opens the Cohere dashboard externally
- [ ] Ollama install link opens `ollama.com` externally
- [ ] All external links use `window.api.openExternal` (http/https only)

---

## 9. Window Behavior

- [ ] Window opens at 1000x700
- [ ] Menu bar is hidden
- [ ] Clicking a link inside the app does not open a new Electron window
- [ ] macOS: closing the window does not quit the app; clicking the dock icon reopens it
- [ ] DevTools open automatically in dev mode

---

## 10. Build & Native Modules

### Dev Workflow

- [ ] `pnpm dev` launches the app without errors
- [ ] `pnpm test` runs the full suite green (357 at last count; the exact number grows with new tests — what matters is zero failures)
- [ ] `pnpm test` followed by `pnpm dev` works without ABI crash (posttest hook rebuilds for Electron)

### Production Build

- [ ] `pnpm run build` completes without errors
- [ ] Built app launches and functions correctly

---

## 11. Database & Data Integrity

- [ ] Secrets (API keys, tokens) are stored in the `secrets` table, not `settings`
- [ ] Clearing all data also clears the `secrets` table
- [ ] Schema migrations run on first launch (3 migration versions)
- [ ] Duplicate sources are prevented by unique index on `(provider, root_external_id)`

---

## 12. Phase 7 -- Hardening (audit remediation)

These cover behavior that has no automated coverage and needs a running app;
several (virtualization especially) could not be verified without a display.

### Navigation guard & external links (M17)

- [ ] Every external link (result "Open source", "Get an API key", Ollama link) opens in the OS browser and never navigates the Electron window
- [ ] The app window never replaces its own page (no blank/white screen from a stray navigation)

### CSP (`connect-src 'none'`)

- [ ] `pnpm dev`: HMR still works -- edit a renderer file and the app hot-updates without a manual reload (dev-only CSP relaxation)
- [ ] Production build launches with no CSP-violation errors in the console; search, sync, and OAuth all still work (all network lives in main, so `'none'` must not break anything)

### Virtualized lists (M20) -- use a large data set

- [ ] Notion picker with hundreds/thousands of pages: smooth scroll, rows correctly spaced (no overlap or gaps), filter narrows, "Select all" selects the filtered set, and selection persists while scrolling
- [ ] Drive picker with a large folder: folders then files in order; navigating into a folder and back works; breadcrumbs correct
- [ ] A source's expanded document list with many docs: scrolls within a bounded panel; rows with and without an "open" button are the same height (no misalignment); the "open" button still works
- [ ] Keyboard: visible rows' checkboxes/buttons remain focusable and operable (H8 preserved)

### CJK / RTL chunking (7.3)

- [ ] Sync a source with a Chinese/Japanese (or Arabic/Hebrew) document: it produces multiple chunks (storage-stats chunk count exceeds doc count) and is searchable -- it does not collapse into one giant chunk

### Clean shutdown, crash reporting, OAuth timer (7.1)

- [ ] Quit mid-sync: the app exits cleanly (no multi-second hang) and buffered telemetry flushes (if PostHog is configured)
- [ ] A fatal init error shows an error dialog rather than silently quitting; an uncaught main-process error leaves a console/log diagnostic instead of a silent death

### Entitlements (7.2) -- needs a signed build

- [ ] `pnpm make:mac` produces an app that launches and loads/rebuilds better-sqlite3 under the trimmed hardened-runtime entitlements (the removed `allow-dyld-environment-variables` was not needed)

### Sync queue release & dismissable error panels (F1/F9)

- [ ] Fail a sync (e.g. bad API key): the panel shows the failure with a working Dismiss button
- [ ] While that failed sync's panel is still shown (not yet dismissed), the source's Sync button re-enables
- [ ] "Sync all" with 2 failing sources still goes on to process the remaining sources (the queue does not deadlock)
- [ ] Clicking Sync again (or re-running "Sync all") on a source whose error panel is still shown actually restarts the sync -- not just re-disables the button with nothing happening
