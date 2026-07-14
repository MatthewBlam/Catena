# Manual Test Checklist

Run through this checklist before each release. Start from a clean state (`pnpm dev`) unless noted otherwise.

To fully reset the app (delete the database and start from onboarding):

```sh
rm "$(electron -e "console.log(require('electron').app.getPath('userData'))")/commons.db"
# or manually:
# macOS: rm ~/Library/Application\ Support/commons-app/commons.db
# Windows: del %APPDATA%\commons-app\commons.db
```

---

## 1. First Launch / Onboarding

### Welcome Step

- [ ] App opens to onboarding wizard (not the main app)
- [ ] Title "Welcome to Commons" and description are visible
- [ ] "Get started" button advances to provider step

### Provider Step -- Cohere

- [ ] "Use Cohere API" and "Use Ollama (Local)" buttons are shown
- [ ] Clicking "Use Cohere API" shows the API key form
- [ ] Back arrow returns to the provider choice
- [ ] Pasting an invalid key and submitting shows an error message
- [ ] Pasting a valid key shows a green success message and advances
- [ ] "Get an API key" link opens `dashboard.cohere.com` in the default browser

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

- [ ] Shows "Try searching your synced docs" with 4 example question cards
- [ ] Clicking an example card fills the input and triggers a search

### Search Input

- [ ] Input is auto-focused on mount
- [ ] Placeholder reads "Ask a question..."
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

- [ ] Searching with no synced documents returns "No results found"
- [ ] Searching with a very long query does not crash
- [ ] Network failure during Cohere reranking shows "Reranking unavailable" warning but still returns results

### Embedding Health

- [ ] If documents were embedded with a different model than the current provider, a dismissible warning appears
- [ ] Dismissing the warning hides it for the session

---

## 4. Sources

### Connect Notion (OAuth)

- [ ] Clicking "Connect Notion" opens the Notion OAuth page in the default browser
- [ ] Completing OAuth in the browser returns focus to the app
- [ ] Browser shows "Connected to Notion! You can close this tab."
- [ ] App transitions to the Notion page picker (page list)

### Connect Notion (Token Paste)

- [ ] "Or paste an integration token" link shows the token input
- [ ] Pasting a token and clicking "Save token" saves it
- [ ] "Cancel" returns to the idle state

### Notion Page Picker

- [ ] Page list loads automatically after OAuth or token paste (spinner while loading)
- [ ] Pages granted during authorization are shown with emoji icon and title
- [ ] Pages without an emoji show a file icon
- [ ] Empty list shows "No pages found" with guidance about granting access
- [ ] API error shows an error banner with a Cancel button
- [ ] Clicking a page selects it and pre-fills the source name
- [ ] Source name is editable before submitting
- [ ] "Back" returns to the page list
- [ ] "Add source" creates the source and refreshes the list
- [ ] "Cancel" returns to the idle state at any point

### Connect Google Drive (OAuth)

- [ ] Clicking "Connect Google Drive" opens the Google OAuth page in the default browser
- [ ] Completing OAuth in the browser returns focus to the app
- [ ] Browser shows "Connected to Google Drive! You can close this tab."
- [ ] App shows the Drive folder picker with the authenticated email

### Drive Folder Picker

- [ ] Source name input accepts text (placeholder "e.g. Club Drive")
- [ ] Pasting a valid Drive folder URL extracts the folder ID
- [ ] Pasting an invalid URL shows "Could not extract a folder ID" error
- [ ] "Add source" creates the source and refreshes the list
- [ ] Labels are properly associated with inputs (click label focuses input)

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
- [ ] Panel shows "Sync canceled" with a "Done" button
- [ ] Partial data from the sync is preserved

### Completion

- [ ] Panel shows "Sync complete" with a "Done" button
- [ ] Document count in the source list updates after closing the panel

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
- [ ] "Get an API key" link opens Cohere dashboard externally
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
- [ ] `pnpm test` runs all tests (expect 118 passing)
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
