export type SupervisorMode = "enforce" | "warn" | "off";
export type AgentClass = "plan" | "other";
export type BudgetReason = "turn-budget" | "tool-budget" | "token-budget" | "duration-timeout";

export interface AgentBudget {
	maxTurns: number;
	maxToolUses: number;
	maxTokens: number;
	maxDurationMs: number;
}

export interface SupervisorConfig {
	mode: SupervisorMode;
	pollIntervalMs: number;
	graceTurns: number;
	budgets: {
		general: AgentBudget;
		plan: AgentBudget;
	};
}

export interface LifetimeUsage {
	input: number;
	output: number;
	cacheWrite: number;
}

export interface SessionLike {
	readonly messages?: Array<{ role?: string }>;
	subscribe(listener: (event: Record<string, any>) => void): () => void;
	steer?(message: string): Promise<void> | void;
}

export interface AgentRecordLike {
	id: string;
	type: string;
	status: string;
	toolUses: number;
	startedAt: number;
	lifetimeUsage: LifetimeUsage;
	invocation?: { maxTurns?: number };
	session?: SessionLike;
}

export interface ManagerRegistry {
	getRecord(id: string): AgentRecordLike | undefined;
}

export interface EventBusLike {
	on(channel: string, handler: (data: any) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export interface LimitEvent {
	id: string;
	agentClass: AgentClass;
	reason: BudgetReason;
	observed: number;
	limit: number;
	timestamp: string;
}
