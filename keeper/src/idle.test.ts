import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSettle } from "./idle.js";

const base = { everSettled: true, sameAsLastSettle: true, openOrders: 0n, sinceLastMs: 60_000, idleHeartbeatMs: 600_000 };

test("idle flat whale with empty queue is skipped", () => assert.equal(shouldSettle(base), false));
test("first settle always goes", () => assert.equal(shouldSettle({ ...base, everSettled: false }), true));
test("changed account value settles", () => assert.equal(shouldSettle({ ...base, sameAsLastSettle: false }), true));
test("queued orders settle", () => assert.equal(shouldSettle({ ...base, openOrders: 2n }), true));
test("unreadable queue settles", () => assert.equal(shouldSettle({ ...base, openOrders: undefined }), true));
test("idle heartbeat settles", () => assert.equal(shouldSettle({ ...base, sinceLastMs: 600_000 }), true));
