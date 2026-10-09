import fs from "node:fs";
import path from "node:path";

import { SitePilotStore, PolicyError } from "./core.js";
import { SqliteState } from "./sqlite-state.js";

const mapObject = (map) => Object.fromEntries(map.entries());

export class JsonSitePilotStore extends SitePilotStore {
  constructor(file) {
    super();
    if (!file || !path.isAbsolute(file)) throw new PolicyError("State file must be an absolute configured path", "POLICY_DENIED");
    this.file = path.resolve(file);
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
    for (const [key, value] of Object.entries(data.projects || {})) this.projects.set(key, value);
    for (const [key, value] of Object.entries(data.runs || {})) this.runs.set(key, value);
    for (const [key, value] of Object.entries(data.tasks || {})) this.tasks.set(key, value);
    for (const [key, value] of Object.entries(data.candidates || {})) this.candidates.set(key, value);
    for (const [key, value] of Object.entries(data.drafts || {})) this.drafts.set(key, value);
    this.audit = Array.isArray(data.audit) ? data.audit : [];
  }

  persist() {
    const payload = JSON.stringify({ projects: mapObject(this.projects), runs: mapObject(this.runs), tasks: mapObject(this.tasks), candidates: mapObject(this.candidates), drafts: mapObject(this.drafts), audit: this.audit }, null, 2);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, payload, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  createProject(input) { const value = super.createProject(input); this.persist(); return value; }
  createRun(...args) { const value = super.createRun(...args); this.persist(); return value; }
  task(...args) { const value = super.task(...args); this.persist(); return value; }
  completeTask(...args) { const value = super.completeTask(...args); this.persist(); return value; }
  createCandidate(...args) { const value = super.createCandidate(...args); this.persist(); return value; }
  markQuality(...args) { const value = super.markQuality(...args); this.persist(); return value; }
  packageReview(...args) { const value = super.packageReview(...args); this.persist(); return value; }
  event(...args) { const value = super.event(...args); if (this.file) this.persist(); return value; }
}

export class SqliteSitePilotStore extends SitePilotStore {
  constructor(file) {
    super();
    this.state = new SqliteState(file, "core", { projects: {}, runs: {}, tasks: {}, candidates: {}, drafts: {}, audit: [] });
    for (const name of ["projects", "runs", "tasks", "candidates", "drafts"]) {
      for (const [id, value] of Object.entries(this.state.data[name] || {})) this[name].set(id, value);
    }
    this.audit = this.state.data.audit || [];
  }
  persist() {
    this.state.save({ projects: mapObject(this.projects), runs: mapObject(this.runs), tasks: mapObject(this.tasks), candidates: mapObject(this.candidates), drafts: mapObject(this.drafts), audit: this.audit });
  }
  createProject(input) { const value = super.createProject(input); this.persist(); return value; }
  createRun(...args) { const value = super.createRun(...args); this.persist(); return value; }
  task(...args) { const value = super.task(...args); this.persist(); return value; }
  completeTask(...args) { const value = super.completeTask(...args); this.persist(); return value; }
  createCandidate(...args) { const value = super.createCandidate(...args); this.persist(); return value; }
  markQuality(...args) { const value = super.markQuality(...args); this.persist(); return value; }
  packageReview(...args) { const value = super.packageReview(...args); this.persist(); return value; }
  event(...args) { const value = super.event(...args); if (this.state) this.persist(); return value; }
  close() { this.state.close(); }
}
