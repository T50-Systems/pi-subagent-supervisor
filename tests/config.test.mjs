import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.ts";

test("uses balanced defaults", () => {
  const config = resolveConfig();
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(config.budgets.general.maxDurationMs, 30 * 60_000);
  assert.equal(config.budgets.plan.maxDurationMs, 15 * 60_000);
});

test("deep-merges global and project budget overrides", () => {
  const config = resolveConfig(
    { mode: "warn", budgets: { general: { maxTokens: 200_000 } } },
    { mode: "enforce", graceTurns: 2, budgets: { plan: { maxToolUses: 12 } } },
  );
  assert.equal(config.mode, "enforce");
  assert.equal(config.graceTurns, 2);
  assert.equal(config.budgets.general.maxTokens, 200_000);
  assert.equal(config.budgets.general.maxTurns, 25);
  assert.equal(config.budgets.plan.maxToolUses, 12);
  assert.equal(config.budgets.plan.maxTokens, 100_000);
});

test("project configuration can tighten but cannot disable global policy", () => {
  const config = resolveConfig(
    { mode: "enforce", pollIntervalMs: 500, graceTurns: 5 },
    { mode: "off", pollIntervalMs: 5_000, graceTurns: 20, budgets: { general: { maxTokens: 300_000 } } },
  );
  assert.equal(config.mode, "enforce");
  assert.equal(config.pollIntervalMs, 500);
  assert.equal(config.graceTurns, 5);
  assert.equal(config.budgets.general.maxTokens, 150_000);
});

test("rejects invalid and unreasonable values per field", () => {
  const config = resolveConfig({
    mode: "broken",
    pollIntervalMs: 0,
    graceTurns: -1,
    budgets: {
      general: { maxTurns: 0, maxToolUses: 100_001, maxTokens: -5, maxDurationMs: Infinity },
    },
  });
  assert.deepEqual(config, DEFAULT_CONFIG);
});
