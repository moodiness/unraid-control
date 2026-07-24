import assert from "node:assert/strict";
import test from "node:test";
import { createLocalAuth } from "./localAuth.js";

test("verifies the configured local password", () => {
  const auth = createLocalAuth("correct horse battery staple");

  assert.equal(auth.verifyPassword("correct horse battery staple"), true);
  assert.equal(auth.verifyPassword("incorrect password"), false);
});

test("accepts valid sessions and rejects expired or modified tokens", () => {
  const now = 1_750_000_000_000;
  const auth = createLocalAuth("correct horse battery staple");
  const token = auth.createSession(now, 60_000);
  const replacement = token.endsWith("x") ? "y" : "x";

  assert.equal(auth.verifySession(token, now), true);
  assert.equal(auth.verifySession(token, now + 60_001), false);
  assert.equal(
    auth.verifySession(`${token.slice(0, -1)}${replacement}`, now),
    false,
  );
  assert.equal(
    createLocalAuth("a different secure password").verifySession(token, now),
    false,
  );
});

test("rejects weak configured passwords", () => {
  assert.throws(() => createLocalAuth("too-short"), /at least 12 characters/);
});
