import { createCodeAtlasAdapterFromEnvironment } from "./codeatlas.js";

const repositories = (process.env.CODEATLAS_REPOSITORIES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (!repositories.length) throw new Error("CODEATLAS_REPOSITORIES must contain at least one approved repository");

const adapter = createCodeAtlasAdapterFromEnvironment({ repositories });
const status = await adapter.indexStatus();
console.log(JSON.stringify({ ok: true, url: process.env.CODEATLAS_MCP_URL, repositories, indexStatus: status }, null, 2));
