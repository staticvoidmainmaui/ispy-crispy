# Hybrid Search + RRF Fusion

**Topic:** RAG / hybrid retrieval
**Where it lives in this project:** `db/07_match_memories_hybrid_fts.sql`

## The idea

Hybrid search runs two retrievers — 

* dense (vector/cosine) 
and 
* lexical (Postgres full-text, `ts_rank_cd`) — 

and fuses their results. The problem: the two score
scales are incomparable (cosine ~0–1, `ts_rank_cd` ~0–10+). 

**Reciprocal Rank Fusion (RRF)** 

solves it by throwing away both scores and keeping only *rank position*, then scoring each doc as `1/(k + rank)`.

## Concrete walk-through (`rrf_k = 60`)

| doc | dense_rank | fts_rank |
|---|---|---|
| A | 1 | 3 |
| B | 2 | (not found) |
| C | (not found) | 1 |

B was found only by the vector half; C only by the lexical half — that's why the
query uses a **FULL OUTER JOIN** (neither half's misses get dropped).

### Lines 82–83 — RRF fusion

```sql
coalesce(1.0/(rrf_k + d.dense_rank), 0) + coalesce(1.0/(rrf_k + f.fts_rank), 0)
```

- **Doc A:** `1/(60+1) + 1/(60+3)` = `0.0164 + 0.0159` = **0.0323**
- **Doc B:** `1/(60+2) + coalesce(1/(60+NULL),0)` = `0.0161 + 0` = **0.0161**
- **Doc C:** `coalesce(1/(60+NULL),0) + 1/(60+1)` = `0 + 0.0164` = **0.0164**


### Why the scores are tiny

RRF **never looks at cosine similarity**. It kept only *position* — rank 1, 2, 3 —
and discarded the distances. So magnitude has nothing to do with similarity; it's
purely `1/(60 + rank)`. Even rank 1 is only `1/61 ≈ 0.016`. That's by design: two
incomparable scales are made comparable by using rank alone.

### Line 94 — normalization

Raw RRF values (~0.016–0.032) are off-scale from recency/importance (0–1), so rescale:

```sql
rrf_score / max(rrf_score) over () as relevance
```

Max is doc A's **0.0323**:

- **Doc A:** `0.0323 / 0.0323` = **1.00**
- **Doc C:** `0.0164 / 0.0323` = **0.51**
- **Doc B:** `0.0161 / 0.0323` = **0.50**

## One-line intuition

RRF's numbers are small because they're `1/(60+rank)` — a rank-position score, not a
similarity score. `coalesce(...,0)` lets a doc found by only one half still count.
Normalization then stretches those tiny fractions back onto the 0–1 scale the
composite expects.

## Related

- Pre-filtering — [pre-filtering.md](pre-filtering.md) (narrows candidates before this
  ranking runs).
- Composite scoring — Park et al., "Generative Agents" (2023).