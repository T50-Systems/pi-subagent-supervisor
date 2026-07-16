import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.ts";
import { stopSubagent } from "../src/rpc.ts";
import { SubagentSupervisor } from "../src/supervisor.ts";
import type { LimitEvent } from "../src/types.ts";

interface UiContext {
	cwd: string;
	hasUI?: boolean;
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

function resumeAgentId(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const record = event as Record<string, unknown>;
	if (typeof record.toolName !== "string" || record.toolName.toLowerCase() !== "agent") return undefined;
	if (!record.input || typeof record.input !== "object") return undefined;
	const resume = (record.input as Record<string, unknown>).resume;
	return typeof resume === "string" && resume.length > 0 ? resume : undefined;
}

function limitMessage(event: LimitEvent, enforced: boolean): string {
	const action = enforced ? "stopped" : "warning";
	return `Subagent supervisor ${action}: ${event.reason} (${event.observed}/${event.limit}) [${event.id}]`;
}

export default function (pi: ExtensionAPI) {
	let supervisor: SubagentSupervisor | undefined;
	let activeContext: UiContext | undefined;

	pi.on("session_start", async (_event, ctx) => {
		supervisor?.stop();
		activeContext = ctx as UiContext;
		const config = await loadConfig(ctx.cwd);
		supervisor = new SubagentSupervisor({
			events: pi.events,
			config,
			stopAgent: (id, signal) => stopSubagent(pi.events, id, 2_000, signal),
			onLimit: (event, enforced) => {
				if (activeContext?.hasUI !== false) {
					activeContext?.ui.notify(limitMessage(event, enforced), enforced ? "error" : "warning");
				}
			},
		});
		supervisor.start();
	});

	pi.on("tool_call", (event) => {
		const id = resumeAgentId(event);
		if (id) supervisor?.watch(id, undefined, true);
	});

	pi.events.on("subagent-supervisor:stop_failed", (event: any) => {
		if (activeContext?.hasUI !== false) {
			activeContext?.ui.notify(
				`Subagent supervisor could not stop ${event?.id ?? "agent"}; retry ${event?.attempt ?? "?"} scheduled.`,
				"error",
			);
		}
	});

	pi.on("session_shutdown", () => {
		supervisor?.stop();
		supervisor = undefined;
		activeContext = undefined;
	});

	pi.registerCommand("subagent-supervisor", {
		description: "Show subagent runtime supervisor status and budgets",
		handler: async (_args, ctx) => {
			if (!supervisor) {
				ctx.ui.notify("Subagent supervisor is not active.", "warning");
				return;
			}
			const config = supervisor.getConfig();
			const format = (name: string, budget: typeof config.budgets.general) =>
				`${name}: ${budget.maxTurns} turns, ${budget.maxToolUses} tools, ${budget.maxTokens} tokens, ${Math.round(budget.maxDurationMs / 60_000)} min`;
			ctx.ui.notify([
				`mode: ${config.mode}`,
				`active monitors: ${supervisor.activeCount()}`,
				`poll: ${config.pollIntervalMs} ms; turn grace: ${config.graceTurns}`,
				format("general", config.budgets.general),
				format("plan", config.budgets.plan),
			].join("\n"), "info");
		},
	});
}
