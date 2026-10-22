import assert from "node:assert/strict";
import test from "node:test";
import { resetNonce, takeNonce, type NonceCursor } from "./nonce.js";

test("later settles ignore a stale pending nonce", () => {
  const cursor: NonceCursor = {};
  assert.equal(takeNonce(cursor, 4), 4);
  assert.equal(takeNonce(cursor, 4), 5);
  assert.equal(takeNonce(cursor, 0), 6);
});

test("reset reads the node again", () => {
  const cursor: NonceCursor = {};
  takeNonce(cursor, 4);
  resetNonce(cursor);
  assert.equal(takeNonce(cursor, 9), 9);
});
