# Pre-filtering in Vector Retrieval

**Topic:** RAG / agent-memory retrieval
**Where it lives in this project:** `db/04_match_memories_ranked.sql`

## The idea

Pre-filtering means narrowing the candidate set with a `WHERE` clause **before**
scoring and ranking — as opposed to post-filtering, where you fetch the top-N by
similarity and *then* drop rows that don't match. Filter-first means ranking budget
is only ever spent on rows that are eligible to be returned.

```
pre-filter:   WHERE type='semantic'  →  score  →  order  →  limit N
post-filter:  score  →  order  →  limit N  →  drop type≠'semantic'  (may return < N)
```

Post-filtering can silently under-return: if the nearest N vectors are all the wrong
type, you get nothing back even though good matches existed just outside the top-N.

## How we implemented it

`match_memories` takes an optional `p_memory_type` parameter (default `null`). The
filter is one line inside the `filtered` CTE, applied in the `WHERE` — before the
`signals` / `composite` scoring CTEs and before `limit`:

```sql
where m.embedding is not null
  and (p_user_id is null or m.user_id = p_user_id)
  and (p_memory_type is null or m.memory_type = p_memory_type)  -- pre-filter
```

`null = all types`, so existing callers that pass nothing get identical results — the
baseline behavior (and the 18/18 eval) is preserved.

## Why it's load-bearing here

The headline feature — "inject only **semantic** memories into the system prompt as
preferences; treat episodic as calendar facts" — is exactly a pre-filter:
`p_memory_type => 'semantic'`. Episodic rows never even enter the ranking.

## What to remember

- Filter before you score, not after.
- Keep the filter optional (`null = all`) so it's additive, never a behavior change.
- The `WHERE` runs before the HNSW ANN traversal is consumed — see the pgvector
  "Filtering" docs for how the index interacts with the predicate.

## Related

- Composite scoring (relevance + recency + importance) — Park et al., "Generative
  Agents" (2023), implemented in the same file.
