import test from "node:test";
import assert from "node:assert/strict";
import { applyUnifiedDiff, validateUnifiedDiff } from "../src/code-patch.js";

const replacement = `--- a/src/page.js
+++ b/src/page.js
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;

test("CodePatch applies a bounded replacement when context matches", () => {
  assert.equal(applyUnifiedDiff("one\ntwo\nthree\n", replacement, "src/page.js"), "one\nTWO\nthree\n");
});

test("CodePatch rejects stale source context", () => {
  assert.throws(() => applyUnifiedDiff("one\nchanged\nthree\n", replacement, "src/page.js"), (error) => error.code === "STALE_SOURCE_REVISION");
});

test("CodePatch rejects malformed hunks and path mismatches", () => {
  assert.throws(() => applyUnifiedDiff("one\ntwo\nthree\n", replacement.replace("@@ -1,3 +1,3 @@", "@@ -1,3 +1,2 @@"), "src/page.js"), (error) => error.code === "SCHEMA_REJECTED");
  assert.throws(() => validateUnifiedDiff(replacement, "src/other.js"), (error) => error.code === "POLICY_DENIED");
});

test("CodePatch rejects metadata and binary payloads", () => {
  const metadata = replacement.replace("@@ -1,3 +1,3 @@", "diff --git a/src/page.js b/src/page.js\n@@ -1,3 +1,3 @@");
  const binary = replacement.replace("@@ -1,3 +1,3 @@", "GIT binary patch\n@@ -1,3 +1,3 @@");
  assert.throws(() => validateUnifiedDiff(metadata, "src/page.js"), (error) => error.code === "POLICY_DENIED");
  assert.throws(() => validateUnifiedDiff(binary, "src/page.js"), (error) => error.code === "POLICY_DENIED");
});
