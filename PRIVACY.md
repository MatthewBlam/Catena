# Privacy

Catena is local-first: your documents, their embeddings, and your search index
live in a SQLite database on your machine. That database is never uploaded, and
there is no account and no server holding a copy of it.

Local-first is not local-only, and the difference matters — with the default
provider, the _text_ of what you sync is sent out to be turned into embeddings,
even though the database itself never moves. This document says exactly what
leaves your device, to whom, and how to stop it.

## What leaves your device

### Depends on your embedding provider

**Cohere** (the default). Four separate flows send your content to
`api.cohere.com`:

| When            | What is sent                                                                                              | Endpoint     |
| --------------- | --------------------------------------------------------------------------------------------------------- | ------------ |
| Every sync      | The full text of every chunk of every document you sync                                                   | `/v2/embed`  |
| Every search    | Your query, verbatim, to be rewritten into a better one                                                   | `/v2/chat`   |
| Every search    | The text of the ~40 best-matching chunks, to be reranked                                                  | `/v2/rerank` |
| Every AI answer | Your question, plus the text of the sources it is grounded on — up to 8, each trimmed to 2,000 characters | `/v2/chat`   |

The first row is the big one, and it is easy to miss: **choosing Cohere means the
text of every document you sync is sent to Cohere.** This is inherent to using a
hosted embedding model — there is no way to turn a document into a vector on
Cohere's servers without sending Cohere the document.

The last row is worth reading twice too. Clicking **Generate answer** sends the
relevant excerpts of your documents to Cohere a second time, as context for the
model that writes the answer. The **Elaborate** checkbox changes how the answer
is written, not what is sent.

Saving a Cohere API key also makes one request — a fixed one-word probe to
`/v2/embed`, to check the key works. It contains nothing of yours.

Cohere does not retain data submitted through its API for model training. That is
their policy, not a technical guarantee, and it is worth reading yourself:
<https://cohere.com/security>.

**Ollama.** None of your content leaves your device. Embedding, query rewriting,
and AI answers all run against `localhost:11434`. Reranking is skipped entirely —
there is no local equivalent, so results are ordered by the raw hybrid-search
score instead. If you want Catena to be local-only for your documents, this is
the setting. Switch in Settings → Embedding Provider.

Setting Ollama up is the one exception, and it is a one-time download rather than
anything about you: if you let Catena install and manage Ollama, it fetches the
engine from GitHub and the models from Ollama's registry. Neither request carries
your documents, your queries, or anything else of yours.

### Regardless of provider

**Your document sources.** Syncing fetches your pages and files from Notion or
Google Drive using OAuth tokens you granted. That is the point of the app. Tokens
are encrypted at rest with your OS keychain (`safeStorage`) and never leave your
machine.

The two connectors ask for very different amounts of access, and it is worth
knowing which you are giving:

- **Notion** can only see the pages you tick on its consent screen. Catena never
  sees the rest of your workspace. Adding pages later means running that consent
  screen again, because the selection you make there replaces the previous one.
- **Google Drive** asks for `drive.readonly` — read access to your **whole**
  Drive. Google offers no narrower scope for this, so the picker inside Catena
  limits what gets _synced_, not what the token _could_ read. It also asks for
  `userinfo.email`, purely so the app can show you which account is connected.

**Anonymous usage analytics**, unless you turn them off. See below.

## Analytics

On by default. Turn them off in **Settings → Privacy → Anonymous usage
analytics**. The setting survives "Clear all data" — clearing your data does not
silently opt you back in.

Events go to PostHog, identified only by a random UUID generated on first launch.
It is not derived from anything about you or your machine, and is not linked to
any account.

Catena sends exactly nineteen events:

| Event                               | Properties                                                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catena_app_opened`                 | app version, OS platform, number of sources / documents / chunks, embedding provider, whether auto-sync is on                                                         |
| `catena_search_executed`            | number of results, whether rerank failed, whether the query was rewritten, embedding provider, duration                                                               |
| `catena_answer_requested`           | embedding provider, chat model name, number of sources the answer will be grounded on, whether it was a retry, whether "Elaborate" was ticked                         |
| `catena_answer_generated`           | the same, plus total duration, time to the first word, answer length in characters, number of citations, error kind and failure reason, how many sources were dropped |
| `catena_answer_cancelled`           | the same request properties, plus how long it ran, time to the first word, characters seen before you pressed Stop, and whether any text had appeared yet             |
| `catena_answer_citation_opened`     | the citation's position in the source list (`1`, `2`, …)                                                                                                              |
| `catena_answer_elaborate_toggled`   | whether the "Elaborate" checkbox was turned on or off                                                                                                                 |
| `catena_sync_started`               | source provider (`notion` / `google_drive`), whether it was manual or automatic                                                                                       |
| `catena_sync_completed`             | the same, plus documents processed, documents skipped, number of errors, whether it ended in error, duration, and embedding provider                                  |
| `catena_source_added`               | source provider                                                                                                                                                       |
| `catena_source_removed`             | source provider                                                                                                                                                       |
| `catena_embedding_provider_changed` | the new provider                                                                                                                                                      |
| `catena_auto_sync_toggled`          | enabled or disabled                                                                                                                                                   |
| `catena_ollama_setup_started`       | OS platform, and which operation (engine setup or chat-model download)                                                                                                |
| `catena_ollama_setup_completed`     | the same                                                                                                                                                              |
| `catena_ollama_uninstall_started`   | OS platform                                                                                                                                                           |
| `catena_ollama_uninstall_completed` | OS platform                                                                                                                                                           |
| `catena_ollama_model_changed`       | whether it was the embedding or the chat model                                                                                                                        |
| `catena_data_cleared`               | none                                                                                                                                                                  |

**No event carries a query, a question, a document, a chunk, a title, a URL, a
file name, an email address, or an API key.** `catena_search_executed` records
that a search happened and how it went — never what you searched for, and the
`catena_answer_*` events record how an AI answer went — never what was asked or
what was answered. "Chat model name" is the name of the model itself (for example
`command-r-08-2024` or `llama3.2`), not anything it produced.

## Where your data lives

Your documents, their embeddings, the search index, your settings, your saved
searches, and your credentials are in one SQLite database under Electron's
`userData` directory:

- macOS: `~/Library/Application Support/Catena/catena.db`
- Windows: `%APPDATA%\Catena\catena.db`

Delete the app's data directory, or use **Settings → Clear all data**, and it is
gone. There is no server-side copy to ask us to delete, because there is no
server.

If you use the managed Ollama, two things live outside that database:

| What                               | Where                                                             | Removed by                                     |
| ---------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------- |
| The Ollama engine Catena installed | `<userData>/ollama`                                               | Settings → **Uninstall Ollama**                |
| Models downloaded to run it        | `~/.ollama/models`, shared with any Ollama you installed yourself | Settings → **Uninstall Ollama**, but see below |

That model store is shared, which is why **Uninstall Ollama** removes only the
models Catena downloaded itself — anything you had pulled before installing
Catena is left alone. Neither location is touched by **Clear all data**, which
clears the database; use **Uninstall Ollama** for these.

## Credentials

| Secret                       | Where it lives                                            |
| ---------------------------- | --------------------------------------------------------- |
| Notion / Google OAuth tokens | Your device, encrypted with the OS keychain               |
| Cohere API key               | Your device, encrypted with the OS keychain               |
| Notion client secret         | A Cloudflare Worker we run (`worker/`) — never in the app |
| Google client secret         | In the app bundle, and readable by anyone — see below     |

The Notion client secret is ours, not yours. It cannot ship in the app, because
anything in the bundle can be read out of it; the token exchange therefore runs
through a Worker that does nothing but attach that secret and forward the request
to Notion. It sees an authorization code in transit and stores nothing.

The Google one ships in the bundle, and that is deliberate rather than an
oversight: Google explicitly designates desktop-client secrets non-confidential,
and the flow is secured by PKCE instead. It is ours, and it grants nothing on its
own.

## What Catena remembers about your accounts

Alongside the credentials above, a few plain (unencrypted) values are kept in the
database so the app can tell you what it is connected to:

| Value                             | Why it is kept                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Your Google account email         | Shown so you can see which account is connected, and to warn you if reconnecting would switch to a different one |
| Your Notion workspace name and id | Same reason — to warn you before a re-authorization moves you to another workspace                               |
| A random device id                | The analytics identifier described above. Not derived from anything about you                                    |

The first two never leave your device: **no analytics event carries them**, and
they are removed when you disconnect that source. The device id survives "Clear
all data" on purpose, so a wipe does not silently re-enrol you as a new user.

## Questions

Open an issue: <https://github.com/MatthewBlam/Catena/issues>.
