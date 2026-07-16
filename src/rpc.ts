import { randomUUID } from "node:crypto";
import type { EventBusLike } from "./types.ts";

export function stopSubagent(
	events: EventBusLike,
	agentId: string,
	timeoutMs = 2_000,
	signal?: AbortSignal,
): Promise<boolean> {
	return new Promise((resolve) => {
		const requestId = randomUUID();
		const replyChannel = `subagents:rpc:stop:reply:${requestId}`;
		let settled = false;
		const finish = (result: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const onAbort = () => finish(false);
		const unsubscribe = events.on(replyChannel, (reply) => finish(reply?.success === true));
		const timer = setTimeout(() => finish(false), timeoutMs);
		timer.unref?.();
		if (signal?.aborted) {
			finish(false);
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		events.emit("subagents:rpc:stop", { requestId, agentId });
	});
}
