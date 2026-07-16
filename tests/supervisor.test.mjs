import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { SubagentSupervisor } from "../src/supervisor.ts";

class FakeBus {
  handlers = new Map();
  emitted = [];
  on(name, handler) {
    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(handler);
    this.handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }
  emit(name, data) {
    this.emitted.push({ name, data });
    for (const handler of this.handlers.get(name) ?? []) handler(data);
  }
}

class FakeSession {
  listeners = new Set();
  steers = [];
  messages = [];
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  steer(message) {
    this.steers.push(message);
  }
  emit(event) {
    for (const listener of this.listeners) listener(event);
  }
}

function harness({
	 type = "general-purpose",
	 configPatch = {},
	 invocationMaxTurns,
	 initialStatus = "running",
	 managerAvailable = true,
	 stopResults = [true],
	 baselineExisting = false,
} = {}) {
  const session = new FakeSession();
  const record = {
    id: "agent-1",
    type,
    status: initialStatus,
    toolUses: 0,
    startedAt: 1_000,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    invocation: invocationMaxTurns ? { maxTurns: invocationMaxTurns } : undefined,
    session,
  };
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config, configPatch);
  if (configPatch.budgets) {
    config.budgets.general = { ...DEFAULT_CONFIG.budgets.general, ...configPatch.budgets.general };
    config.budgets.plan = { ...DEFAULT_CONFIG.budgets.plan, ...configPatch.budgets.plan };
  }
  const bus = new FakeBus();
  const stops = [];
  const limits = [];
  let now = 1_000;
  let available = managerAvailable;
  let stopIndex = 0;
  const supervisor = new SubagentSupervisor({
    events: bus,
    config,
    getManager: () => ({ getRecord: () => available ? record : undefined }),
    stopAgent: async (id) => {
      stops.push(id);
      return stopResults[Math.min(stopIndex++, stopResults.length - 1)];
    },
    now: () => now,
    onLimit: (event, enforced) => limits.push({ event, enforced }),
  });
  supervisor.watch(record.id, record.type, baselineExisting);
  return {
    supervisor, session, record, bus, stops, limits,
    setNow: (value) => { now = value; },
    setAvailable: (value) => { available = value; },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("uses the lower resolved invocation turn limit and allows grace turns", async () => {
  const h = harness({ invocationMaxTurns: 3, configPatch: { graceTurns: 2 } });
  for (let i = 0; i < 3; i++) h.session.emit({ type: "turn_end" });
  assert.equal(h.session.steers.length, 1);
  assert.equal(h.stops.length, 0);
  h.session.emit({ type: "turn_end" });
  assert.equal(h.stops.length, 0);
  h.session.emit({ type: "turn_end" });
  await flush();
  assert.deepEqual(h.stops, ["agent-1"]);
  assert.equal(h.limits[0].event.reason, "turn-budget");
});

test("requests cancellation when an additional tool starts", async () => {
  const h = harness({ configPatch: { budgets: { general: { maxToolUses: 2 } } } });
  h.session.emit({ type: "tool_execution_start" });
  h.session.emit({ type: "tool_execution_start" });
  assert.equal(h.session.steers.length, 1);
  assert.equal(h.stops.length, 0);
  h.session.emit({ type: "tool_execution_start" });
  await flush();
  assert.deepEqual(h.stops, ["agent-1"]);
  assert.equal(h.limits[0].event.reason, "tool-budget");
  assert.equal(h.limits[0].event.observed, 3);
});

test("stops after cumulative assistant usage reaches the token budget", async () => {
  const h = harness({ configPatch: { budgets: { general: { maxTokens: 100 } } } });
  h.record.lifetimeUsage = { input: 70, output: 20, cacheWrite: 10 };
  h.session.emit({
    type: "message_end",
    message: { role: "assistant", usage: { input: 70, output: 20, cacheWrite: 10 } },
  });
  await flush();
  assert.deepEqual(h.stops, ["agent-1"]);
  assert.equal(h.limits[0].event.reason, "token-budget");
});

test("starts wall-clock timeout when the agent is running", async () => {
  const h = harness({ configPatch: { budgets: { general: { maxDurationMs: 1_000 } } } });
  h.setNow(1_999);
  h.supervisor.tick();
  assert.equal(h.stops.length, 0);
  h.setNow(2_000);
  h.supervisor.tick();
  await flush();
  assert.deepEqual(h.stops, ["agent-1"]);
  assert.equal(h.limits[0].event.reason, "duration-timeout");
});

test("warn mode emits a sanitized event without stopping", async () => {
  const h = harness({ configPatch: { mode: "warn", budgets: { general: { maxTokens: 10 } } } });
  h.record.lifetimeUsage = { input: 10, output: 0, cacheWrite: 0 };
  h.supervisor.tick();
  await flush();
  assert.equal(h.stops.length, 0);
  assert.equal(h.limits[0].enforced, false);
  const payload = h.bus.emitted.find((entry) => entry.name === "subagent-supervisor:limit_exceeded").data;
  assert.deepEqual(Object.keys(payload).sort(), ["agentClass", "id", "limit", "observed", "reason", "timestamp"]);
});

test("Plan uses the stricter class budget", async () => {
  const h = harness({ type: "Plan", configPatch: { budgets: { plan: { maxToolUses: 1 } } } });
  h.session.emit({ type: "tool_execution_start" });
  h.session.emit({ type: "tool_execution_start" });
  await flush();
  assert.equal(h.limits[0].event.agentClass, "plan");
  assert.equal(h.limits[0].event.limit, 1);
});

test("retries a watch when the manager record is published late", async () => {
  const h = harness({ managerAvailable: false, configPatch: { budgets: { general: { maxTokens: 10 } } } });
  assert.equal(h.supervisor.activeCount(), 1);
  h.supervisor.tick();
  h.setAvailable(true);
  h.supervisor.tick();
  h.record.lifetimeUsage = { input: 10, output: 0, cacheWrite: 0 };
  h.supervisor.tick();
  await flush();
  assert.deepEqual(h.stops, ["agent-1"]);
});

test("keeps a resumed terminal record until it transitions to running", async () => {
  const h = harness({ initialStatus: "completed", baselineExisting: true, configPatch: { budgets: { general: { maxDurationMs: 100 } } } });
  h.setNow(1_050);
  h.supervisor.tick();
  assert.equal(h.supervisor.activeCount(), 1);
  h.record.status = "running";
  h.record.startedAt = 1_050;
  h.supervisor.tick();
  h.setNow(1_150);
  h.supervisor.tick();
  await flush();
  assert.deepEqual(h.stops, ["agent-1"]);
});

test("backs off failed stop RPC attempts and emits failure state", async () => {
  const h = harness({
    stopResults: [false, true],
    configPatch: { budgets: { general: { maxDurationMs: 100 } } },
  });
  h.setNow(1_100);
  h.supervisor.tick();
  await flush();
  assert.equal(h.stops.length, 1);
  assert.ok(h.bus.emitted.some((entry) => entry.name === "subagent-supervisor:stop_failed"));
  h.supervisor.tick();
  await flush();
  assert.equal(h.stops.length, 1);
  h.setNow(2_100);
  h.supervisor.tick();
  await flush();
  assert.equal(h.stops.length, 2);
});

test("stop removes live session subscriptions", () => {
  const h = harness();
  assert.equal(h.session.listeners.size, 1);
  h.supervisor.stop();
  assert.equal(h.session.listeners.size, 0);
  assert.equal(h.supervisor.activeCount(), 0);
});

test("reconstructs early turns from session messages after delayed attachment", async () => {
  const h = harness({
    managerAvailable: false,
    invocationMaxTurns: 2,
    configPatch: { graceTurns: 0 },
  });
  h.session.messages.push({ role: "assistant" }, { role: "assistant" });
  h.setAvailable(true);
  h.supervisor.tick();
  await flush();
  assert.deepEqual(h.stops, ["agent-1"]);
  assert.equal(h.limits[0].event.reason, "turn-budget");
});

test("retries a failed turn-budget stop from the polling loop", async () => {
  const h = harness({
    invocationMaxTurns: 1,
    stopResults: [false, true],
    configPatch: { graceTurns: 0 },
  });
  h.session.emit({ type: "turn_end" });
  await flush();
  assert.equal(h.stops.length, 1);
  h.setNow(2_000);
  h.supervisor.tick();
  await flush();
  assert.equal(h.stops.length, 2);
});
