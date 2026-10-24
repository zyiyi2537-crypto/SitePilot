import { PolicyError } from "./core.js";

const HUNK = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@(?: .*)?$/;

export function validateUnifiedDiff(diff, filePath) {
  if (typeof diff !== "string" || !diff || diff.length > 64 * 1024 || diff.includes("\0")) throw new PolicyError("CodePatch diff must be bounded text", "SCHEMA_REJECTED");
  const lines = diff.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 4 || lines[0] !== `--- a/${filePath}` || lines[1] !== `+++ b/${filePath}`) throw new PolicyError("CodePatch diff must modify exactly its declared path", "POLICY_DENIED");
  if (lines.some((line) => line.startsWith("diff --git ") || line.startsWith("rename ") || line.startsWith("new file mode ") || line.startsWith("deleted file mode ") || line.startsWith("GIT binary patch") || line.startsWith("\\ "))) throw new PolicyError("CodePatch diff metadata and binary changes are not allowed", "POLICY_DENIED");
  return `${lines.join("\n")}\n`;
}

export function applyUnifiedDiff(source, diff, filePath) {
  const normalized = validateUnifiedDiff(diff, filePath);
  if (typeof source !== "string" || source.includes("\0") || !source.endsWith("\n")) throw new PolicyError("CodePatch source must be UTF-8 text ending with a newline", "SOURCE_INVALID");
  const lines = normalized.slice(0, -1).split("\n");
  const sourceLines = source.slice(0, -1).split("\n");
  const output = [];
  let sourcePosition = 0;
  let diffPosition = 2;
  let hunkCount = 0;
  while (diffPosition < lines.length) {
    const header = HUNK.exec(lines[diffPosition++]);
    if (!header) throw new PolicyError("CodePatch contains malformed unified diff hunk metadata", "SCHEMA_REJECTED");
    const oldStart = Number(header[1]);
    const oldCount = Number(header[2]);
    const newStart = Number(header[3]);
    const newCount = Number(header[4]);
    if (!oldCount || !newCount || oldStart < 1 || newStart < 1) throw new PolicyError("CodePatch hunks must retain at least one source and output line", "SCHEMA_REJECTED");
    const sourceIndex = oldStart - 1;
    if (sourceIndex < sourcePosition || sourceIndex > sourceLines.length) throw new PolicyError("CodePatch hunk is outside the current source", "STALE_SOURCE_REVISION");
    output.push(...sourceLines.slice(sourcePosition, sourceIndex));
    sourcePosition = sourceIndex;
    if (newStart !== output.length + 1) throw new PolicyError("CodePatch hunk output line numbers are inconsistent", "SCHEMA_REJECTED");
    let consumedOld = 0;
    let producedNew = 0;
    let sawChange = false;
    while (diffPosition < lines.length && !lines[diffPosition].startsWith("@@ ")) {
      const line = lines[diffPosition++];
      const prefix = line[0];
      const value = line.slice(1);
      if (prefix === " ") {
        if (sourceLines[sourcePosition] !== value) throw new PolicyError(`CodePatch context does not match ${filePath}`, "STALE_SOURCE_REVISION");
        output.push(value); sourcePosition += 1; consumedOld += 1; producedNew += 1;
      } else if (prefix === "-") {
        if (sourceLines[sourcePosition] !== value) throw new PolicyError(`CodePatch removal does not match ${filePath}`, "STALE_SOURCE_REVISION");
        sourcePosition += 1; consumedOld += 1; sawChange = true;
      } else if (prefix === "+") {
        output.push(value); producedNew += 1; sawChange = true;
      } else throw new PolicyError("CodePatch hunk contains an unsupported line", "SCHEMA_REJECTED");
      if (consumedOld > oldCount || producedNew > newCount) throw new PolicyError("CodePatch hunk exceeds its declared bounds", "SCHEMA_REJECTED");
    }
    if (!sawChange || consumedOld !== oldCount || producedNew !== newCount) throw new PolicyError("CodePatch hunk line counts do not match its header", "SCHEMA_REJECTED");
    if (++hunkCount > 100) throw new PolicyError("CodePatch contains too many hunks", "SCHEMA_REJECTED");
  }
  if (!hunkCount) throw new PolicyError("CodePatch must contain at least one hunk", "SCHEMA_REJECTED");
  output.push(...sourceLines.slice(sourcePosition));
  return `${output.join("\n")}\n`;
}
