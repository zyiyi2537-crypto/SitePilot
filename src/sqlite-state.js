import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { PolicyError } from "./core.js";

export class SqliteState {
  constructor(file, key, initial) {
    if (!file || !path.isAbsolute(file)) throw new PolicyError("SQLite state path must be absolute", "POLICY_DENIED");
    this.db = new DatabaseSync(path.resolve(file));
    fs.chmodSync(file, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL)");
    this.db.prepare("INSERT OR IGNORE INTO state (key, version, data) VALUES (?, 0, ?)").run(key, JSON.stringify(initial));
    const row = this.db.prepare("SELECT version, data FROM state WHERE key=?").get(key);
    this.key = key;
    this.version = row.version;
    this.data = JSON.parse(row.data);
  }

  save(data) {
    const result = this.db.prepare("UPDATE state SET data=?, version=version+1 WHERE key=? AND version=?").run(JSON.stringify(data), this.key, this.version);
    if (!result.changes) throw new PolicyError("SQLite state was changed by another writer; restart before retrying", "STALE_REVISION");
    this.version += 1;
  }

  close() { this.db.close(); }
}
