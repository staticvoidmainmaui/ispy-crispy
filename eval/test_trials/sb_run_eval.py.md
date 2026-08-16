# Stage 0 Baseline — Supabase/pgvector
**18/18 passed.** Captured 2026-08-13.

Tiered Eval Harness. This is the "before" number for the CockroachDB port. 

## Result

```
PASS  s1-add-01       book dentist Friday 3pm
PASS  s1-add-02       schedule study session tomorrow at 9am a
PASS  s1-add-03       please add gym session tonight
PASS  s1-add-04       remind me I like mornings
PASS  s1-pref-01      I hate Monday meetings
PASS  s1-pref-02      I prefer studying at night
PASS  s1-pref-03      I always study late
PASS  s1-pref-04      I can't stand early standups
PASS  s1-q-01         what's on my schedule Friday?
PASS  s1-q-02         when is my dentist appointment
PASS  s1-q-03         my favorite is late-night coding
PASS  s1b-third-01    my sister loves mornings
PASS  s1b-noverb-01   dentist Friday 3pm
PASS  s2-extract-01   schedule study session tomorrow at 9am a
PASS  s2-extract-02   add groceries
PASS  s3-inject-01    What should I do on Friday?
PASS  s3-thirdperson-01  when should I schedule things ?
PASS  s4-fresh-wins-01  when should I study?

18/18 passed
```

| Case | Stage | Input | Result |
| --- | --- | --- | --- |
| s1-add-01 | intent | book dentist Friday 3pm | PASS |
| s1-add-02 | intent | schedule study session tomorrow at 9am at the library | PASS |
| s1-add-03 | intent | please add gym session tonight | PASS |
| s1-add-04 | intent | remind me I like mornings | PASS |
| s1-pref-01 | intent | I hate Monday meetings | PASS |
| s1-pref-02 | intent | I prefer studying at night | PASS |
| s1-pref-03 | intent | I always study late | PASS |
| s1-pref-04 | intent | I can't stand early standups | PASS |
| s1-q-01 | intent | what's on my schedule Friday? | PASS |
| s1-q-02 | intent | when is my dentist appointment | PASS |
| s1-q-03 | intent | my favorite is late-night coding | PASS |
| s1b-third-01 | intent | my sister loves mornings | PASS |
| s1b-noverb-01 | intent | dentist Friday 3pm | PASS |
| s2-extract-01 | extract | schedule study session tomorrow at 9am at the library | PASS |
| s2-extract-02 | extract | add groceries | PASS |
| s3-inject-01 | retrieval | What should I do on Friday? | PASS |
| s3-thirdperson-01 | retrieval | when should I schedule things ? | PASS |
| s4-fresh-wins-01 | ranking | when should I study? | PASS |

## Environment

| Node | v24.13.0 |
| Memory store | Supabase Postgres + pgvector |
| **Retrieval function** | **`match_memories` from `db/04_match_memories_ranked.sql`** |
| Embeddings | `Xenova/all-MiniLM-L6-v2`, 384-dim, mean pooling, normalized |
| Generation model | `claude-sonnet-5` |
| Tier-2 classifier | `claude-haiku-4-5` |

### Tuning constants in force

| Constant | Value | Source |
| --- | --- | --- |
| `DISTANCE_THRESHOLD` | 0.6 | `src/chat/handleMessage.mjs:25` |
| Composite score | `0.7·relevance + 0.3·recency + 0.1·importance` | `db/04_match_memories_ranked.sql:76` |
| Recency decay tau | 1 week | `db/04_match_memories_ranked.sql` |
| Semantic recall budget | `topK: 2` | `src/chat/handleMessage.mjs:319` |
| Episodic recall budget | `topK: 3` | `src/chat/handleMessage.mjs:320` |
| RRF `k` | 60 (unused — `db/07` not wired) | `db/07_match_memories_hybrid_fts.sql:21` |
