import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentBudget, SupervisorConfig, SupervisorMode } from "./types.ts";

export const DEFAULT_CONFIG: SupervisorConfig = {
	mode: "enforce",
	pollIntervalMs: 500,
	graceTurns: 5,
	budgets: {
		general: { maxTurns: 25, maxToolUses: 50, maxTokens: 150_000, maxDurationMs: 30 * 60_000 },
		plan: { maxTurns: 15, maxToolUses: 25, maxTokens: 100_000, maxDurationMs: 15 * 60_000 },
	},
};

const MODES = new Set<SupervisorMode>(["enforce", "warn", "off"]);

function positiveInteger(value: unknown, fallback: number, ceiling: number): number {
	return Number.isInteger(value) && (value as number) > 0 && (value as number) <= ceiling
		? (value as number)
		: fallback;
}

function sanitizeBudget(raw: unknown, fallback: AgentBudget): AgentBudget {
	const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
	return {
		maxTurns: positiveInteger(value.maxTurns, fallback.maxTurns, 10_000),
		maxToolUses: positiveInteger(value.maxToolUses, fallback.maxToolUses, 100_000),
		maxTokens: positiveInteger(value.maxTokens, fallback.maxTokens, 100_000_000),
		maxDurationMs: positiveInteger(value.maxDurationMs, fallback.maxDurationMs, 7 * 24 * 60 * 60_000),
	};
}

function applyLayer(config: SupervisorConfig, raw: unknown): SupervisorConfig {
	if (!raw || typeof raw !== "object") return config;
	const value = raw as Record<string, unknown>;
	if (typeof value.mode === "string" && MODES.has(value.mode as SupervisorMode)) {
		config.mode = value.mode as SupervisorMode;
	}
	config.pollIntervalMs = positiveInteger(value.pollIntervalMs, config.pollIntervalMs, 60_000);
	config.graceTurns = Number.isInteger(value.graceTurns) && (value.graceTurns as number) >= 0 && (value.graceTurns as number) <= 100
		? value.graceTurns as number
		: config.graceTurns;
	const budgets = value.budgets && typeof value.budgets === "object"
		? value.budgets as Record<string, unknown>
		: {};
	config.budgets.general = sanitizeBudget(budgets.general, config.budgets.general);
	config.budgets.plan = sanitizeBudget(budgets.plan, config.budgets.plan);
	return config;
}

const MODE_RANK: Record<SupervisorMode, number> = { off: 0, warn: 1, enforce: 2 };

function tightenWithProject(global: SupervisorConfig, raw: unknown): SupervisorConfig {
	const candidate = applyLayer(structuredClone(global), raw);
	const stricterMode = MODE_RANK[candidate.mode] > MODE_RANK[global.mode] ? candidate.mode : global.mode;
	const tighterBudget = (base: AgentBudget, proposed: AgentBudget): AgentBudget => ({
		maxTurns: Math.min(base.maxTurns, proposed.maxTurns),
		maxToolUses: Math.min(base.maxToolUses, proposed.maxToolUses),
		maxTokens: Math.min(base.maxTokens, proposed.maxTokens),
		maxDurationMs: Math.min(base.maxDurationMs, proposed.maxDurationMs),
	});
	return {
		mode: stricterMode,
		pollIntervalMs: Math.min(global.pollIntervalMs, candidate.pollIntervalMs),
		graceTurns: Math.min(global.graceTurns, candidate.graceTurns),
		budgets: {
			general: tighterBudget(global.budgets.general, candidate.budgets.general),
			plan: tighterBudget(global.budgets.plan, candidate.budgets.plan),
		},
	};
}

export function resolveConfig(globalLayer?: unknown, projectLayer?: unknown): SupervisorConfig {
	const global = applyLayer(structuredClone(DEFAULT_CONFIG), globalLayer);
	return tightenWithProject(global, projectLayer);
}

async function readJson(filePath: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

export async function loadConfig(cwd: string): Promise<SupervisorConfig> {
	const globalSettings = await readJson(path.join(getAgentDir(), "settings.json"));
	const globalLayer = globalSettings && typeof globalSettings === "object"
		? (globalSettings as Record<string, unknown>).subagentSupervisor
		: undefined;
	const projectLayer = await readJson(path.join(cwd, ".pi", "subagent-supervisor.json"));
	return resolveConfig(globalLayer, projectLayer);
}
