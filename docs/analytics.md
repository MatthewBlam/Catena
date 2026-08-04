# Catena Analytics

Everything Catena reports to PostHog: all 18 events with their exact properties,
how to fire each one by hand so it registers, and which dashboards to build from
them.

The user-facing version of this list — the one that has to stay honest — lives in
[PRIVACY.md](../PRIVACY.md). Any change here needs a matching change there.

> **Event prefix changed in the Commons → Catena rename (August 2026).** Every
> event was `commons_*` before and is `catena_*` now. Data ingested under the old
> names is still in PostHog but does not roll up with the new names. There is no
> dual-write — nothing emits `commons_*` anymore.

---

## 1. How telemetry works

Everything runs in the **main process**. `src/main/telemetry/posthog.ts` owns the
client; `track(event, properties)` is the only way to send anything.

- **Identity** is a random UUID generated on first launch and stored in the
  `device_id` setting. Not derived from the machine, not linked to an account.
  One device = one "person" in PostHog.
- **Opt-out** is Settings → Privacy → Anonymous usage analytics. It is read
  before the API-key guard, so the toggle always shows the truth, and it survives
  "Clear all data."
- **No renderer bridge.** The renderer cannot send arbitrary events. Main exposes
  one narrow IPC channel per interaction it wants to hear about
  (`answer:citation-opened` is the only one today), and
  `src/renderer/src/lib/telemetry.ts` is the renderer half. This is deliberate: a
  general "send any event" bridge is a hole through which query text could
  eventually leak.
- **Buffering:** `flushAt: 10`, `flushInterval: 30_000`. Events flush on
  `will-quit` with a 2s bound. **Quit the app to force a flush.**
- **The key:** events only leave the machine when `POSTHOG_API_KEY` is set. It is
  inlined at build time by the `define` block in `electron.vite.config.ts`, so a
  change to `.env` requires a rebuild.

**The invariant:** no event carries a query, a question, an answer, a document, a
chunk, a title, a URL, a file name, an email address, or an API key. Events
record _what happened and how it went_, never _what it was about_.
`answer_model` is the name of a model (`command-r-08-2024`, `llama3.2`), never
anything it produced.

---

## 2. The event catalogue

18 events, grouped by area.

### 2.1 Lifecycle

#### `catena_app_opened`

Once per launch, after the database is open and migrations have run.

| Property             | Type      | Notes                   |
| -------------------- | --------- | ----------------------- |
| `app_version`        | `string`  | From `app.getVersion()` |
| `platform`           | `string`  | `darwin`, `win32`, …    |
| `source_count`       | `number`  | Connected sources       |
| `document_count`     | `number`  | Indexed documents       |
| `chunk_count`        | `number`  | Indexed chunks          |
| `embedding_provider` | `string`  | `cohere` or `ollama`    |
| `auto_sync_enabled`  | `boolean` |                         |

This is the backbone event: it carries corpus size, so it doubles as the "how big
is a real install" measure.

#### `catena_data_cleared`

Settings → Clear all data. **No properties.**

### 2.2 Search

#### `catena_search_executed`

One completed search. A cancelled or superseded search fires nothing — counting
it would post a 0-result event for every superseded keystroke.

| Property             | Type      | Notes                                   |
| -------------------- | --------- | --------------------------------------- |
| `result_count`       | `number`  | 0 is a meaningful value — see §4.3      |
| `rerank_failed`      | `boolean` | Reranking unavailable; results degraded |
| `query_rewritten`    | `boolean` | The rewriter changed the query          |
| `embedding_provider` | `string`  |                                         |
| `duration_ms`        | `number`  | End to end                              |

### 2.3 AI answers

The lifecycle:

```
User clicks "Generate answer"
   │
   ├─► answer:generate                        src/main/ipc/handlers.ts
   │      ├─ catena_answer_requested  ◄── fired BEFORE the work starts
   │      ├─ chunk re-fetch by id  (docs_dropped is measured here)
   │      ├─ generateAnswer()               src/main/search/answerer.ts
   │      │     └─ onDelta → first_token_ms, streamed_chars
   │      └─ catena_answer_generated  ◄── success AND failure both land here
   │
   ├─► answer:cancel ("user_stop")  └─ catena_answer_cancelled
   └─► answer:citation-opened       └─ catena_answer_citation_opened
```

Two things this shape buys you:

1. **A denominator.** Every completion has a matching request, so
   `requested − generated` is exactly the population that was stopped,
   superseded, or lost to a crash.
2. **A user/app distinction.** `answer:cancel` fires both when the user presses
   **Stop** and when the app abandons its own work (new search, restore,
   unmount). Only `"user_stop"` emits an event — the same reasoning that keeps a
   superseded search from firing `catena_search_executed`.

#### `catena_answer_requested`

| Property             | Type      | Notes                                   |
| -------------------- | --------- | --------------------------------------- |
| `embedding_provider` | `string`  |                                         |
| `answer_model`       | `string`  | `command-r-08-2024`, `llama3.2`, …      |
| `doc_count`          | `number`  | Sources the renderer asked to ground on |
| `retry`              | `boolean` | True when it came from **Try again**    |

#### `catena_answer_generated`

Fired when a generation settles — **success and failure both**, distinguished by
`error_kind`. Never fired for a cancelled generation.

| Property             | Type             | Notes                                                     |
| -------------------- | ---------------- | --------------------------------------------------------- |
| `embedding_provider` | `string`         |                                                           |
| `answer_model`       | `string`         |                                                           |
| `duration_ms`        | `number`         | End to end                                                |
| `first_token_ms`     | `number \| null` | **Perceived** latency. Null when nothing ever streamed    |
| `answer_chars`       | `number`         | Length only, never the text                               |
| `citation_count`     | `number`         | Always 0 on Ollama — it has no citation API               |
| `error_kind`         | `string \| null` | `failed`, `no_model`, or null. Drives what the UI renders |
| `failure_reason`     | `string \| null` | The diagnosis — see §2.4                                  |
| `retry`              | `boolean`        |                                                           |
| `doc_count`          | `number`         | Sources requested                                         |
| `docs_dropped`       | `number`         | Requested minus what survived the re-fetch. Should be 0   |

#### `catena_answer_cancelled`

Fired only when the user presses **Stop**.

| Property             | Type             | Notes                                        |
| -------------------- | ---------------- | -------------------------------------------- |
| `embedding_provider` | `string`         |                                              |
| `answer_model`       | `string`         |                                              |
| `doc_count`          | `number`         |                                              |
| `retry`              | `boolean`        |                                              |
| `elapsed_ms`         | `number`         | How long it ran before the stop              |
| `first_token_ms`     | `number \| null` |                                              |
| `streamed_chars`     | `number`         | How much the user had seen                   |
| `streamed`           | `boolean`        | Stopped before the first word, or mid-answer |

`streamed` is the interesting one. `false` is impatience with the wait; `true` is
a judgement on the answer itself. They call for opposite fixes.

#### `catena_answer_citation_opened`

A `[n]` marker in the answer was clicked. Cohere only — Ollama answers carry no
citations.

| Property   | Type     | Notes                                             |
| ---------- | -------- | ------------------------------------------------- |
| `position` | `number` | 1-based rank in the result list. No title, no URL |

### 2.4 `failure_reason` values

Every one of these renders as the same "Couldn't generate an answer" banner. Only
this property tells them apart after the fact.

| Value             | Means                                                     |
| ----------------- | --------------------------------------------------------- |
| `unauthorized`    | HTTP 401/403 — the API key was rejected                   |
| `rate_limited`    | HTTP 429 — common on Cohere trial keys                    |
| `model_not_found` | HTTP 404 — **the model was retired or isn't on the plan** |
| `provider_error`  | Any other non-OK response, or a missing body              |
| `timeout`         | Hit the 120s generation ceiling                           |
| `no_api_key`      | Cohere selected with no key saved                         |
| `no_chat_model`   | Ollama reachable but no chat model pulled (a setup gap)   |
| `empty_answer`    | The provider succeeded and returned nothing               |
| `no_docs`         | Nothing survived to ground on                             |
| `unknown`         | An exception that wasn't a timeout or an abort            |

`model_not_found` is the one to watch. Cohere retiring the bare `command-r` alias
was exactly this, and it is otherwise indistinguishable from a network blip.

### 2.5 Sources and sync

#### `catena_source_added` / `catena_source_removed`

| Property          | Type     | Notes                      |
| ----------------- | -------- | -------------------------- |
| `source_provider` | `string` | `notion` or `google_drive` |

#### `catena_sync_started`

| Property          | Type     | Notes                      |
| ----------------- | -------- | -------------------------- |
| `source_provider` | `string` | `notion` or `google_drive` |
| `trigger`         | `string` | `manual` or `auto`         |

#### `catena_sync_completed`

Fired in a `finally`, so it lands on failure as well as success.

| Property             | Type     | Notes                                       |
| -------------------- | -------- | ------------------------------------------- |
| `source_provider`    | `string` |                                             |
| `trigger`            | `string` | `manual` or `auto`                          |
| `duration_ms`        | `number` |                                             |
| `doc_count`          | `number` | Documents processed                         |
| `skipped_count`      | `number` | Unchanged since last sync (content hash)    |
| `error_count`        | `number` | Per-document failures                       |
| `phase`              | `string` | `done` or `error` — did the sync itself die |
| `embedding_provider` | `string` |                                             |

`phase: "error"` means the sync died outright. `phase: "done"` with a non-zero
`error_count` means it finished but some documents failed — a partial index.

#### `catena_auto_sync_toggled`

| Property  | Type      |
| --------- | --------- |
| `enabled` | `boolean` |

### 2.6 Providers and the managed Ollama

#### `catena_embedding_provider_changed`

| Property   | Type     | Notes                |
| ---------- | -------- | -------------------- |
| `provider` | `string` | The **new** provider |

#### `catena_ollama_setup_started` / `catena_ollama_setup_completed`

Started fires on entry; completed fires only on a clean finish, so the pair is a
success-rate measure. A cancel or failure emits `started` with no `completed`.

| Property   | Type     | Notes                                                     |
| ---------- | -------- | --------------------------------------------------------- |
| `platform` | `string` | `darwin`, `win32`, …                                      |
| `label`    | `string` | `setup` (engine + embedding model) or `chat-model` (pull) |

#### `catena_ollama_uninstall_started` / `catena_ollama_uninstall_completed`

| Property   | Type     |
| ---------- | -------- |
| `platform` | `string` |

#### `catena_ollama_model_changed`

| Property | Type     | Notes                 |
| -------- | -------- | --------------------- |
| `kind`   | `string` | `embedding` or `chat` |

---

## 3. Firing all 18 events once

New event names only appear in PostHog's autocomplete **after they have been
ingested at least once**. Do this pass first, then build the dashboards in §4.

Prerequisites: `POSTHOG_API_KEY` set in `.env`, a rebuild since (`pnpm dev`), and
Settings → Privacy → analytics **on**.

Work down the list in order — it ends with the destructive ones. **Quit the app
at the end** to force a flush (`flushAt: 10`, `flushInterval: 30s`).

| #   | Event                                                       | How to fire it                                                              |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | `catena_app_opened`                                         | `pnpm dev`                                                                  |
| 2   | `catena_ollama_setup_started` + `_completed` (`setup`)      | Onboarding → choose local/Ollama, let the engine + embedding model finish   |
| 3   | `catena_ollama_setup_started` + `_completed` (`chat-model`) | Generate an answer with no chat model installed → click the download button |
| 4   | `catena_ollama_model_changed` (`embedding`)                 | Settings → change the Ollama embedding model                                |
| 5   | `catena_ollama_model_changed` (`chat`)                      | Settings → change the Ollama chat model                                     |
| 6   | `catena_embedding_provider_changed`                         | Settings → switch provider (Ollama ↔ Cohere)                                |
| 7   | `catena_source_added`                                       | Sources → connect Notion or Drive → pick a root                             |
| 8   | `catena_sync_started` + `catena_sync_completed` (`manual`)  | Sources → Sync                                                              |
| 9   | `catena_auto_sync_toggled`                                  | Settings → toggle auto-sync                                                 |
| 10  | `catena_sync_started` + `_completed` (`auto`)               | Leave auto-sync on at the shortest interval and wait for one tick           |
| 11  | `catena_search_executed`                                    | Run any search that returns results                                         |
| 12  | `catena_answer_requested` + `catena_answer_generated`       | Click **Generate answer**, let it finish                                    |
| 13  | `catena_answer_cancelled`                                   | Generate again → click **Stop** mid-stream                                  |
| 14  | `catena_answer_citation_opened`                             | On a **Cohere** answer, click a `[1]` marker                                |
| 15  | `catena_ollama_uninstall_started` + `_completed`            | Settings → remove the managed Ollama                                        |
| 16  | `catena_source_removed`                                     | Sources → remove a source                                                   |
| 17  | `catena_data_cleared`                                       | Settings → Clear all data — **destructive, do this last**                   |

### Firing the interesting property values

| Value                             | How                                                                    |
| --------------------------------- | ---------------------------------------------------------------------- |
| `retry: true`                     | Cause any answer failure, then click **Try again**                     |
| `streamed: false` (cancelled)     | Click **Stop** before the first word appears                           |
| `streamed: true` (cancelled)      | Click **Stop** after text starts appearing                             |
| `failure_reason: unauthorized`    | Save a garbage Cohere key, then generate                               |
| `failure_reason: rate_limited`    | Generate repeatedly on a trial key until 429                           |
| `failure_reason: model_not_found` | Temporarily set `COHERE_ANSWER_MODEL` in `answerer.ts` to a bogus name |
| `failure_reason: no_chat_model`   | Switch to Ollama with no chat model pulled                             |
| `failure_reason: no_api_key`      | Select Cohere, delete the key, generate                                |
| `result_count: 0`                 | Search for something absent from your corpus                           |
| `phase: "error"` (sync)           | Revoke the Notion/Drive token, then sync                               |
| `error_count > 0` (sync)          | Put a corrupt or password-protected PDF in the synced folder           |
| `docs_dropped > 0`                | Generate an answer, and delete the source mid-generation               |

Not reachable by hand: `failure_reason` of `empty_answer`, `no_docs`, `timeout`,
`unknown` — all covered by unit tests instead.

---

## 4. The dashboards

Four dashboards. Build them in this order — each is useful on its own, and the
later ones assume the earlier events exist.

Set every dashboard's default date filter to **Last 30 days**, and remember that
`distinct_id` is per-device, so "unique users" means "unique installs."

### 4.1 Dashboard A — Health & Adoption

The one you glance at. Everything sources from `catena_app_opened`.

| Insight                 | Type   | Config                                                                    |
| ----------------------- | ------ | ------------------------------------------------------------------------- |
| **Active installs**     | Trends | `catena_app_opened`, **Unique users**, weekly interval                    |
| **Launches per user**   | Trends | `catena_app_opened` total ÷ unique users (Formula `A/B`)                  |
| **Corpus size**         | Trends | `catena_app_opened`, **P50 of `chunk_count`**; add P90 as a second series |
| **Sources per install** | Trends | `catena_app_opened`, **Average of `source_count`**                        |
| **Provider split**      | Trends | `catena_app_opened`, unique users, **breakdown by `embedding_provider`**  |
| **Platform split**      | Trends | `catena_app_opened`, unique users, **breakdown by `platform`**, pie       |
| **Version adoption**    | Trends | `catena_app_opened`, unique users, **breakdown by `app_version`**, area   |

Corpus size is the one that quietly matters: `searcher.ts` warns at 5,000 chunks
and the vector scan is bounded, so watching P90 `chunk_count` tells you when real
installs are approaching the ceiling.

### 4.2 Dashboard B — Onboarding & Setup

Where new installs die.

| Insight                  | Type   | Config                                                                                                                       |
| ------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Activation funnel**    | Funnel | `catena_app_opened` → `catena_source_added` → `catena_sync_completed` → `catena_search_executed`, unique users, 7-day window |
| **Ollama setup success** | Funnel | `catena_ollama_setup_started` → `catena_ollama_setup_completed`, **breakdown by `label`**                                    |
| **Setup failures by OS** | Funnel | Same, **breakdown by `platform`**                                                                                            |
| **Uninstall rate**       | Trends | Formula: `catena_ollama_uninstall_completed` ÷ `catena_ollama_setup_completed`                                               |
| **Provider switching**   | Trends | `catena_embedding_provider_changed`, **breakdown by `provider`**                                                             |
| **Model changes**        | Trends | `catena_ollama_model_changed`, **breakdown by `kind`**                                                                       |

The activation funnel is the single most important chart in the project — it
answers "does a fresh install ever reach a successful search." A big drop at step
2 is a connector problem; at step 3 a sync problem; at step 4 the user installed
it and never came back.

Ollama setup success broken down by `platform` is where a Windows-specific
download or extraction bug would surface first.

### 4.3 Dashboard C — Search & AI Answers

| Insight                    | Type   | Config                                                                                                             |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| **Answer adoption funnel** | Funnel | `catena_search_executed` → `catena_answer_requested` → `catena_answer_generated`, 1-hour window, unique users      |
| **Perceived latency**      | Trends | `catena_answer_generated`, **P90 `first_token_ms`**; series B P90 `duration_ms`; breakdown by `embedding_provider` |
| **Failure breakdown**      | Trends | `catena_answer_generated`, filter `error_kind is set`, **breakdown by `failure_reason`**, stacked bar              |
| **Model comparison**       | Trends | `catena_answer_generated` count + **Average `citation_count`**, both broken down by `answer_model`                 |
| **Abandonment**            | Trends | `catena_answer_cancelled`, **breakdown by `streamed`**; series B P50 `elapsed_ms`                                  |
| **Citation follow rate**   | Trends | Formula: `catena_answer_citation_opened` ÷ `catena_answer_generated`                                               |
| **Citation depth**         | Trends | `catena_answer_citation_opened`, **breakdown by `position`**                                                       |
| **Retry recovery**         | Trends | `catena_answer_generated`, filter `retry = true`, **breakdown by `error_kind`**                                    |
| **Empty-result rate**      | Trends | Formula: `catena_search_executed where result_count = 0` ÷ all `catena_search_executed`                            |
| **Degraded search**        | Trends | `catena_search_executed`, two series filtered on `rerank_failed = true` and `query_rewritten = true`               |
| **Search latency**         | Trends | `catena_search_executed`, **P90 `duration_ms`**, breakdown by `embedding_provider`                                 |
| **Grounding watchdog**     | Trends | `catena_answer_generated`, filter `docs_dropped > 0` — should be flat zero                                         |

Notes on the ones that aren't obvious:

- **Perceived latency** — `first_token_ms` is what the user experiences; a
  streaming UI feels fast the moment the first word lands. Alert on this, not on
  `duration_ms`. Cohere and Ollama look completely different, which is why the
  breakdown is not optional.
- **Failure breakdown** is the chart that earns its keep. `model_not_found`
  spiking means a provider retired a model out from under you; `unauthorized`
  climbing means keys are rotting; `rate_limited` means trial keys are capped.
  Pin it near the top.
- **Abandonment** — `streamed: false` is a latency problem, `streamed: true` is a
  quality problem. If `false` cancellations track your P90 first-token time,
  that's confirmation.
- **Citation follow rate** is the closest thing to a "was this answer good"
  signal available without a thumbs up/down.
- **Empty-result rate** is a retrieval problem, not an answer problem — if it
  rises, look at chunking and embedding health before touching the answerer.

### 4.4 Dashboard D — Sync Reliability

| Insight                  | Type   | Config                                                                              |
| ------------------------ | ------ | ----------------------------------------------------------------------------------- |
| **Sync outcome**         | Trends | `catena_sync_completed`, **breakdown by `phase`**, stacked bar                      |
| **Partial syncs**        | Trends | `catena_sync_completed`, filter `error_count > 0`, breakdown by `source_provider`   |
| **Documents per sync**   | Trends | `catena_sync_completed`, **Average `doc_count`** and **Average `skipped_count`**    |
| **Sync duration**        | Trends | `catena_sync_completed`, **P90 `duration_ms`**, breakdown by `embedding_provider`   |
| **Manual vs auto**       | Trends | `catena_sync_completed`, **breakdown by `trigger`**                                 |
| **Syncs that never end** | Funnel | `catena_sync_started` → `catena_sync_completed` — the gap is crashes and hard quits |
| **Auto-sync adoption**   | Trends | `catena_auto_sync_toggled`, **breakdown by `enabled`**                              |
| **Source churn**         | Trends | `catena_source_added` and `catena_source_removed` as two series                     |

`skipped_count` rising relative to `doc_count` is the content-hash short-circuit
working — that's healthy. The two to watch are `phase: "error"` and any
divergence in the started → completed funnel.

### 4.5 Suggested alerts

- `catena_answer_generated` where `failure_reason = model_not_found` — **any**
  occurrence. A retired model breaks answers for everyone at once.
- `catena_answer_generated` where `docs_dropped > 0` — any occurrence.
- `catena_sync_completed` where `phase = "error"` — threshold above your normal
  baseline.
- P90 `first_token_ms` above ~8s for `embedding_provider = cohere`.

---

## 5. Caveats

- **`distinct_id` is per-device.** One machine is one "person." Rates are sound;
  "unique users" really means "unique installs."
- **Opt-out is real.** Every number is a sample of consenting installs.
- **Buffered events can be lost** on a hard crash — up to 10 events or 30
  seconds. Every funnel shows a small permanent leak from this alone.
- **Cancelled and superseded work is deliberately uncounted.** Superseded
  searches and superseded generations fire nothing. Only a user-initiated Stop
  produces `catena_answer_cancelled`.
- **`citation_count` is structurally 0 on Ollama.** Never compare it across
  providers; only across Cohere models.
- **Sync events fire per source**, not per sync run. A scheduler tick over three
  sources produces three `catena_sync_started`.

---

## 6. Where the code lives

| Concern                            | File                                                 |
| ---------------------------------- | ---------------------------------------------------- |
| PostHog client, opt-out, `track()` | `src/main/telemetry/posthog.ts`                      |
| `catena_app_opened`                | `src/main/index.ts`                                  |
| Search + answer + source events    | `src/main/ipc/handlers.ts`                           |
| Sync events                        | `src/main/ipc/sync-handlers.ts`                      |
| Ollama events                      | `src/main/ipc/ollama-handlers.ts`                    |
| Failure-reason mapping             | `src/main/search/answerer.ts`                        |
| Shared types & doc comments        | `src/shared/types.ts`                                |
| Renderer half of citation tracking | `src/renderer/src/lib/telemetry.ts`                  |
| Stop / retry wiring                | `src/renderer/src/pages/SearchPage.tsx`              |
| Citation markers                   | `src/renderer/src/components/search/AnswerPanel.tsx` |
| Handler tests                      | `src/main/ipc/__tests__/answer-handlers.test.ts`     |
| Failure-reason tests               | `src/main/search/__tests__/answerer.test.ts`         |

When adding an event, update **PRIVACY.md** in the same change. It states an
exact event count and enumerates every property; a stale privacy policy is worse
than a vague one.
