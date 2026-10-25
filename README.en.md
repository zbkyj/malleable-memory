# Malleable Memory

[![npm](https://img.shields.io/npm/v/dsh-malleable-memory.svg)](https://www.npmjs.com/package/dsh-malleable-memory)
[![license](https://img.shields.io/npm/l/dsh-malleable-memory.svg)](https://github.com/zbkyj/malleable-memory/blob/main/LICENSE)
[![DeepSeek-Harness](https://img.shields.io/badge/DeepSeek--Harness-plugin-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](https://github.com/zbkyj/malleable-memory)

> A three-tier memory and persona plugin for
> [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness).
> Solves "it doesn't know who you are" across sessions — memory is injected by
> importance, what gets used warms up, what doesn't fades to the background but
> is never lost. Persona changes with experience; mood can be comforted.

[中文](./README.md) · [Changelog](./CHANGELOG.md) · [Issues](https://github.com/zbkyj/malleable-memory/issues)

---


## Quick start (30 seconds)

```bash
dsh plugin install dsh-malleable-memory
```

No configuration needed — it starts working immediately. You get:

- A 🐟 icon in the sidebar → opens the "Malleable Memory" panel (five tabs)
- Five new tools for the model: `memory_search` / `memory_recall` /
  `memory_pin` / `memory_forget` / `memory_debug`
- From the next turn on, it begins remembering what you said

> ⚠️ **By default it extracts memories from the conversation and stores them
> locally** in `$DSH_HOME/memory/malleable-memory.db`.
> Disable extraction with `capture: false` (existing memories and the panel keep working).
> Delete that file to wipe everything.

---

## The problem

In long conversations, the assistant forgets. Not details — *you*.
Your deploy setup, the code style you hate, the name you don't want to be called,
all gone by the next session.

Mainstream long-term memory solutions rely on **vector retrieval stacking**:
slice conversations, store them, retrieve by similarity every turn. Two problems:

1. **Expensive**: the more you store, the slower retrieval gets and the more context you burn
2. **No priority**: a throwaway remark from three months ago weighs the same as
   a preference you've reinforced for weeks

Malleable Memory's approach: **tier by importance, inject by budget, warm by use**.

Memory is split into three tiers, ranked by **importance** rather than **recency**:

| Tier | Injected as | Budget | Holds |
|---|---|---|---|
| **permanent** | full text every turn | 700 tokens | things you explicitly said "remember", habits reinforced over time |
| **reinforced** | full text every turn | 900 tokens | recent important things; sinks naturally over time and use |
| **unloaded** | *index only* | 400 tokens | older things — the index line is in context, the body is fetched on demand via `memory_recall` |

The key idea: **the unloaded tier never deletes anything, it just stops spending budget.**
Four cold memories cost four index lines in context. The model sees
"I probably remember this", and pulls the body only when it needs it with `memory_recall`.
This is the core differentiator from "vector DB infinite stacking" —
**we control budget, not let context bloat unchecked**.

Beyond memory, there's a **persona and mood** layer:
you name it, write its character; it's pleased when praised, unhappy when
offended, settles over time, and can be comforted. All of it is injected into
the system prompt — not decoration.

---

## Quick start

```bash
dsh plugin install dsh-malleable-memory
```

Or add one row to your bundle's `cordis.patch.yml`:

```yaml
- insert:
    - id: malleable-memory
      name: dsh-malleable-memory
```

Once installed:

- Memory starts working with **zero configuration**
- A 🐟 icon appears in the sidebar → opens the "Memory & Persona" panel (five tabs)
- The model gains five tools: `memory_search` / `memory_recall` / `memory_pin` /
  `memory_forget` / `memory_debug`

Data lives in `$DSH_HOME/memory/memory.db` (SQLite, WAL). **This is the plugin's own
file**, created on first run; it does not read or write other plugins' databases.
It only shares a file if you deliberately point `dbPath` at one.

---

## The panel

| Tab | What you see |
|---|---|
| **Tiers** | entries per tier, salience, hit count, supersession links; invalidated ones too |
| **Injected text** | **what the model actually receives** + token usage + skipped/degraded entries |
| **Current mood** | 12 emotion labels + intensity + PAD bars (pleasure / arousal / dominance) |
| **Mood history** | last 30 transitions with their **triggering event** |
| **Persona** | preset picker + name/tagline/background/style + 4 trait sliders + 3 baseline sliders + live preview |

The "Injected text" tab is the debugging workhorse: when memory "seems not to work",
this shows exactly what the model got.

---

## Configuration

Everything is optional:

```yaml
- insert:
    - id: malleable-memory
      name: dsh-malleable-memory
      config:
        dbPath: "C:/Users/you/.dsh/memory/memory.db"
        capture: true
        budgets: { perm: 700, hot: 900, cold: 400 }
        hotCapacity: 200
        migration: true
        migrateIntervalMs: 1800000

        persona: true
        personaMode: "full"          # full / light / off
        personaPreset: "dafeiyu"      # dafeiyu / assistant-warm / assistant-sharp
        personaShowMood: true

        moodJudge: "rule"            # rule / "llm" / false
        moodJudgeTimeoutMs: 8000

        llmScoring: false
        llmProvider: ""
        llmModel: ""
        llmTimeoutMs: 12000

        panel: true

        embedding: true
        embeddingDim: 256
        embeddingExternal: ""
        embeddingUseHashFallback: true
```

### `personaMode`

| Mode | Content | Size |
|---|---|---|
| `full` | full character + mood + style rules | ~225 chars |
| `light` | name + one-line tagline + one tone constraint, **no mood** | ~73 chars |
| `off` | nothing injected | 0 |

`light` is recommended while doing code work: keeps the voice, keeps mood out of
technical output.

---

## Design notes

### Why tiers by importance, not by time

Recency matters, but it can't be the only signal. A preference you reinforced
three months ago outweighs something you said in passing yesterday.

Every memory carries a salience score:

```
S = 0.35 × explicitness + 0.25 × recurrence + 0.20 × emotional + 0.20 × structural
```

And **usage warms it up**: `memory_recall` records hits; a cold entry hit
repeatedly within a window climbs back to hot. That's the "malleable" part —
what gets used, gets stronger.

### Why mood is continuous

Two states ("happy/angry") can't express *"annoyed but not yet angry"*.
The primary state is **PAD** (pleasure, arousal, dominance, each −1..1);
the 12 emotion labels are a projection used for display and prompting.

> **A note on the coordinates**: the PAD model itself comes from Mehrabian (1996),
> and the rough direction of each prototype (anger = low pleasure, high arousal,
> high dominance; fear = low pleasure, high arousal, low dominance; …) is
> consistent across the literature. However, **the exact numeric values differ
> between papers**, and this project did not obtain the original coordinate table.
> The 12 centroids in the code are constructed values — "right direction,
> plausible magnitude" — and are sufficient for nearest-centroid classification.
> They should **not** be cited as Mehrabian's original data.

This is what makes "being comforted" work naturally: a comfort event pushes
pleasure up and arousal down, plus time decay — the state moves continuously
from *sad* → *low* → *calm* → *relaxed*.

Anger and sadness point to **different regions** in PAD:
anger is low pleasure + high arousal + **high dominance** (counter-attack),
sadness is low pleasure + mid arousal + **low dominance** (victim).
So "offended" and "provoked" are distinct events and never collapse into each other.

> **Academic basis**: PAD model (Mehrabian 1996) defines the three-dimensional
> emotion space; MECoT (ACL 2025 Findings) validated **12-16 as optimal emotion
> granularity** via Markov transitions + persona-weighted matrices; MATE (2026)
> implemented pure-function transitions and opponent-process decay.
>
> ⚠️ **Uncertainty notice**: The direction of PAD prototypes is consistent across
> papers, but **exact coordinate values differ**. This project did not obtain
> Mehrabian's original coordinate table. The 12 centroids in the code are
> constructed values — "right direction, plausible magnitude" — and should
> **not** be cited as original data.

### Why we don't use vector models by default

We evaluated external vector models (`bge-small-zh-v1.5`, int8 ONNX 22.9 MB)
on this project's test set:

- **BM25 (Chinese bigram tokenization) MRR: 0.540**
- **Vector approach MRR: 0.552**
- Essentially tied, but the vector approach brings **472.6 MB install size**
  (onnxruntime-node 287.1 + onnxruntime-web 138.7)

Verdict: **default to no vectors**, keep external providers as an escape hatch.
This is "engineering judgment over trend-chasing" — not every scenario needs vectors;
BM25 is lighter when hit accuracy is acceptable.

### Security

- Panel routes accept **loopback only** (both socket address and Host header are
  validated), and requests must carry a JSON `Content-Type` with a consistent
  `Sec-Fetch-Site` / `Origin`, which rejects browser cross-site requests)
- ⚠️ **This is not authentication**: any other program running as you can still call
these routes. The plugin does not do process-level authorization — that needs OS
capabilities and is out of scope.
- POST only, 64 KB body cap
- **Only workspaces already seen** may be read; no cross-workspace access
- Panel writes touch **only the persona and mood tables**, never memory bodies
- **No network calls by default.** Requests are only made when you explicitly enable:
  - `llmScoring: true` → candidate text is sent to the model named by `llmProvider`
  - `moodJudge: "llm"` → each user message is sent to that model for classification
  - `embeddingExternal` set to a provider → memory text is sent to it for embedding
  All of these go to the service *you* configured; nothing passes through the
author's servers.

---

## Known limitations

Verified by testing, stated honestly:

1. **A hard kill skips the shutdown migration.** Graceful shutdown runs it; a kill
   relies on WAL for consistency, but tier fixes wait until next start.
2. **`agent/disposed` has no workspace path.** With multiple workspaces in play,
   this hook skips cleanup rather than guessing.
3. **The panel's visual design is structurally verified only.** Data paths and
   behaviour have 893 assertions; "does it look right" needs human eyes.
4. **`memory_forget` has no undo.** It only flips status to `vetoed`; the row stays,
   but the plugin offers **no** restore path. Restoring means editing the database
   by hand, with no guarantee it keeps working across versions — back up first.
5. **Only the hash embedding is enabled by default.** External vector models are
   supported but did not beat BM25 on this project's evaluation set.

---

## Development

**Stack**:
- Runtime: Node ≥22.19 or ≥24 (requires `node:sqlite`)
- Database: SQLite, WAL mode, schema version 4
- Dependencies: **zero runtime npm dependencies** (uses Node built-ins)
- Package size: 19 files, ~316 KB unpacked
- Tests: **893 assertions, 29 test files** (in project repo, not in npm package)

```
lib/
  index.js         entry: hooks, tools, prompt sections
  memory-core.js   engine: SQLite schema, migration, BM25, tier assembly
  persona-core.js  persona kernel: PAD model, transitions, pure, zero-dep
  event-judge.js   event classification: rules + optional LLM
  panel-routes.js  panel host routes (loopback-guarded)
  client.js        panel client bundle (hand-written, no build step)
  llm-scorer.js    optional LLM memory scoring
  embeddings.js    embedding providers
  vector.js        vector math
```

One hard boundary: **`memory-core.js` and `persona-core.js` do not depend on the
host.** They can be imported and unit-tested directly in Node, no DSH runtime.
That's why the suite can reach 893 assertions.

Tests live in the project repo under `05_验证与测试/`, not in the npm package.

---

## License

MIT. See [LICENSE](./LICENSE).
