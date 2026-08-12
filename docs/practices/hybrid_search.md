# Hybrid Search — Resources

Curated (non-redundant) reading for adding sparse/lexical retrieval and fusing it with
the existing dense (pgvector, cosine) path. Kept deliberately short — one link per idea.

## 1. Sparse vs. dense — the concept
- [Pinecone: Hybrid Search](https://www.pinecone.io/learn/hybrid-search-intro/)
  Where dense retrieval fails (exact terms, names, IDs) and why fusing dense + sparse wins.

## 2. BM25 — the lexical scoring model
- [Elastic: Practical BM25](https://www.elastic.co/blog/practical-bm25-part-2-the-bm25-algorithm-and-its-variables)
  The BM25 formula itself (TF saturation, IDF, length normalization) — what `ts_rank` approximates.

## 3. Sparse retrieval in Postgres — tsvector
- [PostgreSQL Full Text Search (Ch. 12)](https://www.postgresql.org/docs/current/textsearch.html)
  Authoritative reference: `to_tsvector`, `to_tsquery`, `@@`, `ts_rank`, GIN indexing. Read 12.1–12.2 first.

  IMPLEMENTATION HERE : 
  (https://github.com/pgvector/pgvector-python/blob/master/examples/hybrid_search/rrf.py)

## 4. True BM25 in Postgres — the extension option
- [ParadeDB pg_search](https://docs.paradedb.com/documentation/getting-started/quickstart)
  Tantivy-backed BM25 with the `@@@` operator — the upgrade path if `ts_rank` becomes the bottleneck.

## 5. Fusion — combining dense + sparse with RRF
- [Microsoft: Relevance scoring in hybrid search using RRF](https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking)
  How RRF (`Σ 1/(k + rank)`) merges the two ranked lists, and when you'd tune weights instead.

  RESEARCH DOC:
  (https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf)

## 6. Evaluation — is hybrid actually better?
- [BEIR benchmark](https://github.com/beir-cellar/beir)
  Methodology template for a dense-vs-hybrid comparison (nDCG@10). Reference for extending the eval harness.
