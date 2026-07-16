import type {
	AgentBudget,
	AgentClass,
	AgentRecordLike,
	BudgetReason,
	EventBusLike,
	LimitEvent,
	ManagerRegistry,
	SupervisorConfig,
} from "./types.ts";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const TERMINAL = new Set(["completed", "steered", "aborted", "stopped", "error"]);
const ACTIVATION_WAIT_MS = 10_000;
const MAX_STOP_RETRY_MS = 30_000;

interface Monitor {
	id: string;
	type: string;
	agentClass: AgentClass;
	budget: AgentBudget;
	startedAt: number;
	activationDeadline: number;
	baselineToolUses: number;
	baselineTokens: number;
	toolStarts: number;
	tokens: number;
	baselineAssistantMessages: number;
	turns: number;
	turnLimit: number;
	turnLimitSteered: boolean;
	toolLimitSteered: boolean;
	stopRequested: boolean;
	stopAttempts: number;
	nextStopAttemptAt: number;
	violation?: LimitEvent;
	active: boolean;
	session?: AgentRecordLike["session"];
	unsubscribeSession?: () => void;
}

interface PendingWatch {
	id: string;
	type?: string;
	baselineExisting: boolean;
	deadline: number;
}

export interface SupervisorOptions {
	events: EventBusLike;
	config: SupervisorConfig;
	getManager?: () => ManagerRegistry | undefined;
	stopAgent: (id: string, signal: AbortSignal) => Promise<boolean>;
	now?: () => number;
	onLimit?: (event: LimitEvent, enforced: boolean) => void;
}

function agentClass(type: string): AgentClass {
	return type.toLowerCase() === "plan" ? "plan" : "other";
}

function finiteUsage(record: AgentRecordLike): number {
	const usage = record.lifetimeUsage;
	return [usage.input, usage.output, usage.cacheWrite]
		.filter((value) => Number.isFinite(value) && value > 0)
		.reduce((sum, value) => sum + value, 0);
}

function eventUsage(event: Record<string, any>): number {
	if (event.type !== "message_end" || event.message?.role !== "assistant") return 0;
	const usage = event.message.usage;
	if (!usage || typeof usage !== "object") return 0;
	return [usage.input, usage.output, usage.cacheWrite]
		.filter((value) => Number.isFinite(value) && value > 0)
		.reduce((sum, value) => sum + value, 0);
}

function assistantMessageCount(session: AgentRecordLike["session"]): number {
	return session?.messages?.filter((message) => message.role === "assistant").length ?? 0;
}

export function globalManagerRegistry(): ManagerRegistry | undefined {
	const registry = (globalThis as Record<PropertyKey, unknown>)[MANAGER_KEY];
	if (!registry || typeof registry !== "object") return undefined;
	return typeof (registry as ManagerRegistry).getRecord === "function" ? registry as ManagerRegistry : undefined;
}

export class SubagentSupervisor {
	private readonly events: EventBusLike;
	private config: SupervisorConfig;
	private readonly getManager: () => ManagerRegistry | undefined;
	private readonly stopAgent: (id: string, signal: AbortSignal) => Promise<boolean>;
	private readonly now: () => number;
	private readonly onLimit?: (event: LimitEvent, enforced: boolean) => void;
	private readonly monitors = new Map<string, Monitor>();
	private readonly pending = new Map<string, PendingWatch>();
	private readonly shutdownController = new AbortController();
	private eventUnsubscribers: Array<() => void> = [];
	private timer?: ReturnType<typeof setInterval>;

	constructor(options: SupervisorOptions) {
		this.events = options.events;
		this.config = options.config;
		this.getManager = options.getManager ?? globalManagerRegistry;
		this.stopAgent = options.stopAgent;
		this.now = options.now ?? Date.now;
		this.onLimit = options.onLimit;
	}

	start(): void {
		if (this.eventUnsubscribers.length > 0) return;
		this.eventUnsubscribers.push(
			this.events.on("subagents:started", (data) => {
				if (typeof data?.id === "string") this.watch(data.id, typeof data.type === "string" ? data.type : undefined, false);
			}),
			this.events.on("subagents:completed", (data) => this.handleTerminal(data)),
			this.events.on("subagents:failed", (data) => this.handleTerminal(data)),
		);
		this.timer = setInterval(() => this.tick(), this.config.pollIntervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		this.shutdownController.abort();
		for (const unsubscribe of this.eventUnsubscribers.splice(0)) unsubscribe();
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		for (const monitor of this.monitors.values()) monitor.unsubscribeSession?.();
		this.monitors.clear();
		this.pending.clear();
	}

	setConfig(config: SupervisorConfig): void {
		this.config = config;
	}

	watch(id: string, type?: string, baselineExisting = false): boolean {
		if (this.monitors.has(id) || this.pending.has(id) || this.config.mode === "off") return false;
		const record = this.getManager()?.getRecord(id);
		if (!record) {
			this.pending.set(id, { id, type, baselineExisting, deadline: this.now() + ACTIVATION_WAIT_MS });
			return true;
		}
		this.createMonitor(record, type, baselineExisting);
		return true;
	}

	activeCount(): number {
		return this.monitors.size + this.pending.size;
	}

	getConfig(): SupervisorConfig {
		return structuredClone(this.config);
	}

	tick(): void {
		this.resolvePending();
		for (const monitor of [...this.monitors.values()]) {
			const record = this.getManager()?.getRecord(monitor.id);
			if (!record) {
				if (this.now() >= monitor.activationDeadline) this.unwatch(monitor.id);
				continue;
			}
			if (record.status === "running" && !monitor.active) {
				monitor.active = true;
				monitor.startedAt = record.startedAt || this.now();
				monitor.baselineToolUses = record.toolUses;
				monitor.baselineTokens = finiteUsage(record);
				monitor.toolStarts = 0;
				monitor.tokens = 0;
				this.attachSession(monitor, record);
			}
			if (TERMINAL.has(record.status)) {
				if (monitor.active || this.now() >= monitor.activationDeadline) this.unwatch(monitor.id);
				continue;
			}
			if (!monitor.active) continue;
			this.attachSession(monitor, record);
			this.reconcileTurns(monitor);
			if (monitor.violation) {
				this.exceed(monitor, monitor.violation.reason, monitor.violation.observed, monitor.violation.limit);
			}
			if (this.now() - monitor.startedAt >= monitor.budget.maxDurationMs) {
				this.exceed(monitor, "duration-timeout", this.now() - monitor.startedAt, monitor.budget.maxDurationMs);
				continue;
			}
			const completedTools = Math.max(0, record.toolUses - monitor.baselineToolUses);
			monitor.toolStarts = Math.max(monitor.toolStarts, completedTools);
			this.checkToolBudget(monitor);
			monitor.tokens = Math.max(monitor.tokens, Math.max(0, finiteUsage(record) - monitor.baselineTokens));
			if (monitor.tokens >= monitor.budget.maxTokens) {
				this.exceed(monitor, "token-budget", monitor.tokens, monitor.budget.maxTokens);
			}
		}
	}

	private resolvePending(): void {
		for (const pending of [...this.pending.values()]) {
			const record = this.getManager()?.getRecord(pending.id);
			if (record) {
				this.pending.delete(pending.id);
				this.createMonitor(record, pending.type, pending.baselineExisting);
			} else if (this.now() >= pending.deadline) {
				this.pending.delete(pending.id);
				this.events.emit("subagent-supervisor:monitor_failed", {
					id: pending.id,
					reason: "record-unavailable",
					timestamp: new Date(this.now()).toISOString(),
				});
			}
		}
	}

	private createMonitor(record: AgentRecordLike, type?: string, baselineExisting = false): void {
		const resolvedType = type ?? record.type;
		const classification = agentClass(resolvedType);
		const budget = this.config.budgets[classification === "plan" ? "plan" : "general"];
		const requestedTurns = record.invocation?.maxTurns;
		const now = this.now();
		const monitor: Monitor = {
			id: record.id,
			type: resolvedType,
			agentClass: classification,
			budget,
			startedAt: record.status === "running" ? record.startedAt : now,
			activationDeadline: now + ACTIVATION_WAIT_MS,
			baselineToolUses: record.toolUses,
			baselineTokens: finiteUsage(record),
			toolStarts: 0,
			tokens: 0,
			baselineAssistantMessages: baselineExisting ? assistantMessageCount(record.session) : 0,
			turns: 0,
			turnLimit: Number.isInteger(requestedTurns) && (requestedTurns as number) > 0
				? Math.min(budget.maxTurns, requestedTurns as number)
				: budget.maxTurns,
			turnLimitSteered: false,
			toolLimitSteered: false,
			stopRequested: false,
			stopAttempts: 0,
			nextStopAttemptAt: 0,
			active: record.status === "running",
		};
		this.monitors.set(record.id, monitor);
		this.attachSession(monitor, record);
	}

	private attachSession(monitor: Monitor, record: AgentRecordLike): void {
		if (!record.session || monitor.session === record.session) return;
		monitor.unsubscribeSession?.();
		monitor.session = record.session;
		this.reconcileTurns(monitor);
		monitor.unsubscribeSession = record.session.subscribe((event) => {
			if (event.type === "turn_end") {
				monitor.turns++;
				this.checkTurnBudget(monitor);
			}
			if (event.type === "tool_execution_start") {
				monitor.toolStarts++;
				this.checkToolBudget(monitor);
			}
			const tokens = eventUsage(event);
			if (tokens > 0) {
				monitor.tokens += tokens;
				if (monitor.tokens >= monitor.budget.maxTokens) {
					this.exceed(monitor, "token-budget", monitor.tokens, monitor.budget.maxTokens);
				}
			}
		});
	}

	private reconcileTurns(monitor: Monitor): void {
		const observed = Math.max(0, assistantMessageCount(monitor.session) - monitor.baselineAssistantMessages);
		if (observed > monitor.turns) {
			monitor.turns = observed;
			this.checkTurnBudget(monitor);
		}
	}

	private checkTurnBudget(monitor: Monitor): void {
		if (!monitor.turnLimitSteered && monitor.turns >= monitor.turnLimit) {
			monitor.turnLimitSteered = true;
			this.steerWrapUp(monitor, "turn budget");
		}
		if (monitor.turns >= monitor.turnLimit + this.config.graceTurns) {
			this.exceed(monitor, "turn-budget", monitor.turns, monitor.turnLimit);
		}
	}

	private checkToolBudget(monitor: Monitor): void {
		if (!monitor.toolLimitSteered && monitor.toolStarts >= monitor.budget.maxToolUses) {
			monitor.toolLimitSteered = true;
			this.steerWrapUp(monitor, "tool budget");
		}
		if (monitor.toolStarts > monitor.budget.maxToolUses) {
			this.exceed(monitor, "tool-budget", monitor.toolStarts, monitor.budget.maxToolUses);
		}
	}

	private steerWrapUp(monitor: Monitor, budgetName: string): void {
		if (this.config.mode !== "enforce") return;
		try {
			void monitor.session?.steer?.(`You have reached the supervisor ${budgetName}. Wrap up immediately and provide your final answer now.`);
		} catch {
			// Best effort; the RPC stop still applies at the hard boundary.
		}
	}

	private exceed(monitor: Monitor, reason: BudgetReason, observed: number, limit: number): void {
		if (!monitor.violation) {
			monitor.violation = {
				id: monitor.id,
				agentClass: monitor.agentClass,
				reason,
				observed,
				limit,
				timestamp: new Date(this.now()).toISOString(),
			};
			const enforced = this.config.mode === "enforce";
			this.events.emit("subagent-supervisor:limit_exceeded", monitor.violation);
			this.onLimit?.(monitor.violation, enforced);
			if (!enforced) {
				monitor.stopRequested = true;
				return;
			}
		}
		if (this.config.mode !== "enforce" || monitor.stopRequested || this.now() < monitor.nextStopAttemptAt) return;
		this.attemptStop(monitor);
	}

	private attemptStop(monitor: Monitor): void {
		monitor.stopRequested = true;
		monitor.stopAttempts++;
		void this.stopAgent(monitor.id, this.shutdownController.signal).then((stopped) => {
			if (stopped || this.shutdownController.signal.aborted) return;
			this.stopFailed(monitor);
		}).catch(() => {
			if (!this.shutdownController.signal.aborted) this.stopFailed(monitor);
		});
	}

	private stopFailed(monitor: Monitor): void {
		monitor.stopRequested = false;
		monitor.nextStopAttemptAt = this.now() + Math.min(MAX_STOP_RETRY_MS, 1_000 * (2 ** Math.min(monitor.stopAttempts - 1, 5)));
		this.events.emit("subagent-supervisor:stop_failed", {
			id: monitor.id,
			reason: monitor.violation?.reason ?? "unknown",
			attempt: monitor.stopAttempts,
			nextRetryAt: new Date(monitor.nextStopAttemptAt).toISOString(),
			timestamp: new Date(this.now()).toISOString(),
		});
	}

	private handleTerminal(data: any): void {
		if (typeof data?.id === "string") this.unwatch(data.id);
	}

	private unwatch(id: string): void {
		const monitor = this.monitors.get(id);
		monitor?.unsubscribeSession?.();
		this.monitors.delete(id);
		this.pending.delete(id);
	}
}
