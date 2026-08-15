// Load .sql files from disk so queries stay readable SQL, not JS strings.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cache = new Map();

export function loadSql(dir, name) {
  const key = `${dir}:${name}`;
  if (!cache.has(key)) {
    cache.set(key, readFileSync(path.join(dir, `${name}.sql`), "utf8"));
  }
  return cache.get(key);
}

export function sqlDir(importMetaUrl, sub = "sql") {
  return path.join(path.dirname(fileURLToPath(importMetaUrl)), sub);
}
