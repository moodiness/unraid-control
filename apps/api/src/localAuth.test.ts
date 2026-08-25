import assert from "node:assert/strict";
import test from "node:test";
import { createLocalAuth } from "./localAuth.js";
const SESSION_SECRET = Buffer.alloc(32, 0x11);
const OTHER_SESSION_SECRET = Buffer.alloc(32, 0x22);

test("verifies the configured local password", () => {
  const auth = createLocalAuth("correct horse battery staple", SESSION_SECRET);

  assert.equal(auth.verifyPassword("correct horse battery staple"), true);
  assert.equal(auth.verifyPassword("incorrect password"), false);
});

test("session verification requires the same password and secret", () => {
  const now = 1_750_000_000_000;
  const auth = createLocalAuth("correct horse battery staple", SESSION_SECRET);
  const token = auth.createSession(now, 60_000);
  const sameCredentials = createLocalAuth(
    "correct horse battery staple",
    SESSION_SECRET,
  );
  const differentSecret = createLocalAuth(
    "correct horse battery staple",
    OTHER_SESSION_SECRET,
  );
  const differentPassword = createLocalAuth(
    "a different secure password",
    SESSION_SECRET,
  );
  const parts = token.split(".");
  const signature = parts[3]!;
  const replacement = signature.startsWith("A") ? "B" : "A";
  const tamperedToken = [
    ...parts.slice(0, 3),
    `${replacement}${signature.slice(1)}`,
  ].join(".");

  assert.equal(auth.verifySession(token, now), true);
  assert.equal(auth.verifySession(token, now + 60_001), false);
  assert.equal(auth.verifySession(tamperedToken, now), false);
  assert.equal(sameCredentials.verifySession(token, now), true);
  assert.equal(differentSecret.verifySession(token, now), false);
  assert.equal(differentPassword.verifySession(token, now), false);
});

test("rejects weak configured passwords", () => {
  assert.throws(
    () => createLocalAuth("too-short", SESSION_SECRET),
    /at least 12 characters/,
  );
});
