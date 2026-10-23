---
name: ggb-rag-manage
description: Search, list, and delete knowledge entries in the ggb-dsh RAG (SQLite FTS5) database. Use when testing solved-task extraction, cleaning up test cases, or inspecting what the agent has learned from successful runs.
---

# GGB RAG Manage

Manage knowledge entries in the ggb-dsh local RAG database (SQLite FTS5 with BM25 ranking).
Primary use: inspecting and deleting test cases from the `solved_tasks` corpus after successful
construction runs.

## Database location

The application database is at `ggb-dsh/.local/web/application.sqlite3`.
Two relevant tables:
- `knowledge_entries` — the canonical store (columns: `knowledge_id`, `title`, `content`, `tags_json`, `corpus_id`, `status`, `version`, `language`, `capability_version`, `source_version`, `reviewed_at`)
- `knowledge_fts` — the FTS5 index (columns: `knowledge_id`, `title`, `content`, `tags`)

## Operations

### List entries

Show all entries in a corpus (default `solved_tasks`):

```bash
sqlite3 ggb-dsh/.local/web/application.sqlite3 \
  "SELECT knowledge_id, title, corpus_id, status, language FROM knowledge_entries WHERE corpus_id = 'solved_tasks' ORDER BY reviewed_at DESC;"
```

### Search entries

Full-text search with BM25 ranking:

```bash
sqlite3 ggb-dsh/.local/web/application.sqlite3 \
  "SELECT e.knowledge_id, e.title, e.corpus_id, snippet(knowledge_fts, 2, '>>>', '<<<', '...', 32) AS snippet
   FROM knowledge_fts f JOIN knowledge_entries e ON e.knowledge_id = f.knowledge_id
   WHERE knowledge_fts MATCH '<query>'
   ORDER BY bm25(knowledge_fts) LIMIT 10;"
```

Replace `<query>` with the search term (double-quote it if it contains spaces).

### Inspect one entry

```bash
sqlite3 ggb-dsh/.local/web/application.sqlite3 \
  "SELECT knowledge_id, title, content, tags_json, corpus_id, status, version, language, reviewed_at
   FROM knowledge_entries WHERE knowledge_id = '<id>';"
```

### Delete by ID

```bash
sqlite3 ggb-dsh/.local/web/application.sqlite3 \
  "DELETE FROM knowledge_fts WHERE knowledge_id = '<id>';
   DELETE FROM knowledge_entries WHERE knowledge_id = '<id>';"
```

### Delete all solved_tasks entries

Useful for resetting before a test run:

```bash
sqlite3 ggb-dsh/.local/web/application.sqlite3 \
  "DELETE FROM knowledge_fts WHERE knowledge_id IN (SELECT knowledge_id FROM knowledge_entries WHERE corpus_id = 'solved_tasks');
   DELETE FROM knowledge_entries WHERE corpus_id = 'solved_tasks';"
```

### Delete by source version

```bash
sqlite3 ggb-dsh/.local/web/application.sqlite3 \
  "DELETE FROM knowledge_fts WHERE knowledge_id IN (SELECT knowledge_id FROM knowledge_entries WHERE corpus_id = 'solved_tasks' AND source_version = '<version>');
   DELETE FROM knowledge_entries WHERE corpus_id = 'solved_tasks' AND source_version = '<version>';"
```

### Count entries by corpus

```bash
sqlite3 ggb-dsh/.local/web/application.sqlite3 \
  "SELECT corpus_id, COUNT(*) AS count FROM knowledge_entries GROUP BY corpus_id;"
```

## Workflow

1. Confirm the database path exists. If not, the bridge has not been started yet; report this.
2. Run the requested operation (list, search, inspect, or delete).
3. For delete operations, always show the entries that will be affected first and confirm with the user before executing the delete.
4. After a delete, report the number of rows removed from each table.
5. Never modify entries in the `geometry_v1` corpus — those are loaded from the version-controlled JSONL source and would be re-synced on next startup.

## HTTP API alternative

When the web bridge is running on `http://127.0.0.1:8787`, the same operations are available via:

- `GET /api/knowledge?query=<q>&corpusId=<c>&limit=<n>` — search
- `DELETE /api/knowledge` — body is JSON criteria: `{"ids":["id1","id2"]}` or `{"corpusId":"solved_tasks","sourceVersion":"v"}` or `{"corpusId":"solved_tasks","before":"2026-01-01"}`

Prefer the sqlite3 approach since the bridge may not be running during testing.
