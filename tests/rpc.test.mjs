import assert from "node:assert/strict";
import test from "node:test";
import { stopSubagent } from "../src/rpc.ts";

class Bus {
  handlers = new Map();
  on(name, handler) {
    this.handlers.set(name, handler);
    return () => this.handlers.delete(name);
  }
  emit(name, data) {
    if (name === "subagents:rpc:stop") {
      queueMicrotask(() => this.handlers.get(`${name}:reply:${data.requestId}`)?.({ success: true }));
    }
  }
}

test("stops an agent through the public pi-subagents RPC", async () => {
  const stopped = await stopSubagent(new Bus(), "agent-1", 100);
  assert.equal(stopped, true);
});

test("fails closed when the RPC is unavailable", async () => {
  const bus = { on: () => () => {}, emit: () => {} };
  const stopped = await stopSubagent(bus, "agent-1", 5);
  assert.equal(stopped, false);
});

test("cancels an outstanding RPC wait during shutdown", async () => {
  const handlers = new Map();
  const bus = {
    on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); },
    emit: () => {},
  };
  const controller = new AbortController();
  const pending = stopSubagent(bus, "agent-1", 10_000, controller.signal);
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(handlers.size, 0);
});
