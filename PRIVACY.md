# Privacy

Commons is local-first: your documents, their embeddings, and your search index
live in a SQLite database on your machine and are never uploaded anywhere.

Local-first is not local-only, and the difference matters. This document says
exactly what leaves your device, to whom, and how to stop it.

## What leaves your device

### Depends on your embedding provider

**Cohere** (the default). Three separate flows send your content to
`api.cohere.com`:

| When         | What is sent                                             | Endpoint     |
| ------------ | -------------------------------------------------------- | ------------ |
| Every sync   | The full text of every chunk of every document you sync  | `/v2/embed`  |
| Every search | Your query, verbatim, to be rewritten into a better one  | `/v2/chat`   |
| Every search | The text of the ~40 best-matching chunks, to be reranked | `/v2/rerank` |

The first row is the big one, and it is easy to miss: **choosing Cohere means the
text of every document you sync is sent to Cohere.** This is inherent to using a
hosted embedding model — there is no way to turn a document into a vector on
Cohere's servers without sending Cohere the document.

Cohere does not retain data submitted through its API for model training. That is
their policy, not a technical guarantee, and it is worth reading yourself:
<https://cohere.com/security>.

**Ollama.** Nothing leaves your device. Embedding, reranking, and query rewriting
all run against `localhost:11434`. If you want Commons to be local-only, this is
the setting. Switch in Settings → Embedding Provider.

### Regardless of provider

**Your document sources.** Syncing fetches your pages and files from Notion or
Google Drive using OAuth tokens you granted. That is the point of the app. Tokens
are encrypted at rest with your OS keychain (`safeStorage`) and never leave your
machine.

**Anonymous usage analytics**, unless you turn them off. See below.

## Analytics

On by default. Turn them off in **Settings → Privacy → Anonymous usage
analytics**. The setting survives "Clear all data" — clearing your data does not
silently opt you back in.

Events go to PostHog, identified only by a random UUID generated on first launch.
It is not derived from anything about you or your machine, and is not linked to
any account.

Commons sends exactly nine events:

| Event                                | Properties                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `commons_app_opened`                 | app version, OS platform, number of sources / documents / chunks, embedding provider, whether auto-sync is on    |
| `commons_search_executed`            | number of results, whether rerank failed, whether the query was rewritten, embedding provider, duration          |
| `commons_sync_started`               | source provider (`notion` / `google_drive`), whether it was manual or automatic                                  |
| `commons_sync_completed`             | the same, plus documents processed, documents skipped, number of errors, whether it ended in error, and duration |
| `commons_source_added`               | source provider                                                                                                  |
| `commons_source_removed`             | source provider                                                                                                  |
| `commons_embedding_provider_changed` | the new provider                                                                                                 |
| `commons_auto_sync_toggled`          | enabled or disabled                                                                                              |
| `commons_data_cleared`               | none                                                                                                             |

**No event carries a query, a document, a chunk, a title, a URL, a file name, an
email address, or an API key.** `commons_search_executed` records that a search
happened and how it went — never what you searched for.

## Where your data lives

Everything is in one SQLite database under Electron's `userData` directory:

- macOS: `~/Library/Application Support/Commons/commons.db`
- Windows: `%APPDATA%\Commons\commons.db`

Delete the app's data directory, or use **Settings → Clear all data**, and it is
gone. There is no server-side copy to ask us to delete, because there is no
server.

## Credentials

| Secret                       | Where it lives                                            |
| ---------------------------- | --------------------------------------------------------- |
| Notion / Google OAuth tokens | Your device, encrypted with the OS keychain               |
| Cohere API key               | Your device, encrypted with the OS keychain               |
| Notion client secret         | A Cloudflare Worker we run (`worker/`) — never in the app |

The Notion client secret is ours, not yours. It cannot ship in the app, because
anything in the bundle can be read out of it; the token exchange therefore runs
through a Worker that does nothing but attach that secret and forward the request
to Notion. It sees an authorization code in transit and stores nothing.

## Questions

Open an issue: <https://github.com/MatthewBlam/commons-app/issues>.
