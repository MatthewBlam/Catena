# Catena — Landing Page Spec

**Page goal:** a visitor understands Catena in ~10 seconds and downloads it.
**Audience:** student organization officers/members with docs scattered across Notion + Google Drive.
**Format:** one scrolling page. Media-forward — a hero product shot, then alternating feature rows each carrying their own short GIF.

## Global elements

- **Top nav (minimal):** `Catena` wordmark left; right side: `Features`, `Privacy`, `GitHub`, and a small **Download** button. Sticky, transparent → solid on scroll.
- **Download CTA (used in 3 places):** two buttons, `Download for Mac` / `Download for Windows`, pointing at the latest GitHub Release assets. Auto-detect OS to bold the likely one; keep both visible.
- **Theme:** light + dark, matching the app (Inter, neutral palette with the app's accent). Dark by default is on-brand for a dev-adjacent tool.
- **Footer:** wordmark, one-line tagline, links (GitHub · Privacy · MIT License · "Built by one developer"), requirements line (_macOS or Windows_).

---

## Section 1 — Hero (product screenshot or GIF)

- **Eyebrow:** `Local-first · Free · Open source`
- **Headline:** **One search box for your organization's scattered docs.**
- **Subhead:** _Catena connects your Notion and Google Drive, indexes everything on your own machine, and lets you search — or just ask — across all of it._
- **CTA:** the two download buttons + thin trust line under them: _Your documents never leave your device._
- **Hero media (the centerpiece):** the app in a clean window frame.
  - **Best option — GIF (~6–8s):** type a real question ("How do I get reimbursed?") → results appear → click **Generate answer** → answer streams in with **cited source cards** underneath. This one loop demonstrates the whole product.
  - **Fallback — static screenshot:** the same answered state (question + streamed answer + source cards visible).
  - Frame it as a floating app window with a soft shadow; let it bleed slightly past the fold so the page invites scrolling.

---

## Section 2 — The problem (short, no media)

One tight paragraph to create recognition before the features:

> Your organization's knowledge is everywhere — onboarding guides in Notion, budgets in Drive, meeting notes in three different docs. A new member asks a simple question and nobody remembers where the answer lives. Catena puts all of it behind one search box.

Keep it to 2–3 lines. This is the only text-only break between media rows.

---

## Section 3 — Features (each row = copy + its own GIF)

Alternating layout: media on one side, copy on the other, flipping each row. Recommend **4 rows** (keeps it simple; each earns its GIF).

**Row 1 — Search that understands meaning**

- Copy: _Semantic + keyword search across every connected doc. "Reimbursement policy" finds "how to expense things" — even when the words don't match._
- **GIF (~4s):** type a natural-language query → ranked results with source snippets appear. Show a result that clearly isn't a literal keyword match.

**Row 2 — Answers, not just links**

- Copy: _Ask a question and get a grounded answer that cites the exact source — click through to the original Notion page or Drive file._
- **GIF (~5s):** click **Generate answer** → text streams → hover/click a citation → it maps to a source card → "Open source" opens the doc.

**Row 3 — Connect Notion & Google Drive in seconds**

- Copy: _Link your sources with OAuth, pick the pages and folders to index, and Catena handles the rest._
- **GIF (~5s):** the onboarding/sources flow — click **Connect Notion**, pick a page, then it appears in the sources list with a doc count.

**Row 4 — Private by design, free to run**

- Copy: _Your docs, embeddings, and search index stay on your machine — there's no server. Bring a Cohere key for pennies a month, or run 100% locally with Ollama (auto-installed, no key)._
- **GIF (~5s):** Settings → the provider toggle (Cohere ⇄ Ollama), or the one-click **Set up Ollama** flow with its progress bar. Reinforces the privacy/free story visually.

_(Optional 5th row if you want it: **Stays fresh in the background** — the background-sync setting + a sync running. Cut it if you want to keep the page short.)_

---

## Section 4 — Closing CTA

- Line: **Bring your organization's knowledge into one place.**
- The two download buttons again + requirements line (_macOS or Windows · Free_).

---

## Asset checklist (the GIFs to record)

Record these from the real app; keep each loop short and captioned by the copy, not text baked into the GIF.

| #    | Where              | Shows                                          | Length |
| ---- | ------------------ | ---------------------------------------------- | ------ |
| Hero | Search page        | question → answer → citations (the whole loop) | 6–8s   |
| 1    | Search page        | semantic query → ranked results                | ~4s    |
| 2    | Answer panel       | generate answer → citation → open source       | ~5s    |
| 3    | Onboarding/Sources | connect Notion → pick page → appears in list   | ~5s    |
| 4    | Settings           | provider toggle / Ollama one-click setup       | ~5s    |

**GIF direction:**

- Same window size for every capture (consistent frame = polished page). ~16:10, retina.
- Trim dead time; loop cleanly; no cursor hunting on screen.
- Use realistic-but-fake organization content (avoid real names/emails — matters given the privacy pitch).
- Keep files light (aim <2–3 MB each; consider looping MP4/WebM over GIF for quality/size, with a poster image fallback).
- Record in **dark mode** if the page defaults to dark, so frames blend into the section background.

---

## Copy blocks (ready to drop in)

- **Headline:** One search box for your organization's scattered docs.
- **Subhead:** Catena connects your Notion and Google Drive, indexes everything on your own machine, and lets you search — or just ask — across all of it.
- **Trust line:** Your documents never leave your device.
- **Closing:** Bring your organization's knowledge into one place.
