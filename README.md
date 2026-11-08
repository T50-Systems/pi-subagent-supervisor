# pi-subagent-supervisor

A runtime-budget and automatic-cancellation companion for [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).

`pi-work-guard` validates an `Agent` request before launch. This extension supervises the running agent after `pi-subagents` resolves its configuration, including frontmatter overrides and resumed sessions.

## Default policy

| Agent class | Turns | Tool starts | Lifetime tokens per invocation | Wall time |
|---|---:|---:|---:|---:|
| General/custom | 25 | 50 | 150,000 | 30 minutes |
| `Plan` | 15 | 25 | 100,000 | 15 minutes |

- At the turn limit, the agent is asked to wrap up and receives 5 grace turns before cancellation.
- At the tool limit, the agent is asked to wrap up. Starting another tool triggers best-effort cancellation, but that tool may already have begun before the asynchronous stop RPC lands.
- Crossing the token budget cancels after the current assistant response. One provider response of overshoot is unavoidable.
- Crossing wall time cancels immediately.
- Cancellation uses the public `subagents:rpc:stop` endpoint.

Tokens follow `pi-subagents` lifetime accounting: `input + output + cacheWrite`; `cacheRead` is excluded.

## Integration contract

The supervisor uses two `pi-subagents` integration surfaces:

1. lifecycle events and the public `subagents:rpc:stop` RPC;
2. `Symbol.for("pi-subagents:manager")`, exposed by `pi-subagents`, to read live records and subscribe to their `AgentSession` events.

The registry is necessary because lifecycle events currently publish totals only when a run terminates. The plugin pins compatibility to `@tintinweb/pi-subagents >= 0.14.1 < 0.15.0`; a new minor version requires revalidation because the live registry is not a documented stable API.

## Installation

```bash
pi install git:github.com/T50-Systems/pi-subagent-supervisor@v0.1.1
```

Install `@tintinweb/pi-subagents` separately. Reload or restart Pi after installation.

## Configuration

Defaults are active in `enforce` mode. Global overrides belong under `subagentSupervisor` in `~/.pi/agent/settings.json`:

```json
{
  "subagentSupervisor": {
    "mode": "enforce",
    "pollIntervalMs": 500,
    "graceTurns": 5,
    "budgets": {
      "general": {
        "maxTurns": 25,
        "maxToolUses": 50,
        "maxTokens": 150000,
        "maxDurationMs": 1800000
      },
      "plan": {
        "maxTurns": 15,
        "maxToolUses": 25,
        "maxTokens": 100000,
        "maxDurationMs": 900000
      }
    }
  }
}
```

Project constraints may be placed in `<cwd>/.pi/subagent-supervisor.json`. They may only tighten global policy: lower budgets/poll/grace values or a stronger mode are accepted; repository-controlled configuration cannot disable or loosen global protection.

Modes:

- `enforce`: notify and stop the agent;
- `warn`: notify once without stopping;
- `off`: do not monitor agents.

Run `/subagent-supervisor` to inspect the resolved policy and active monitor count.

## Events and privacy

A threshold emits `subagent-supervisor:limit_exceeded` with only:

```ts
{ id, agentClass, reason, observed, limit, timestamp }
```

Prompts, descriptions, model output, custom agent names, and tool arguments are never persisted by this plugin.

## Limitations

- Cancellation is cooperative. A third-party in-process tool that ignores `AbortSignal` may not stop promptly.
- This is an overall agent supervisor, not a per-tool timeout. Recoverable tool-call timeouts require wrapping tool execution inside `pi-subagents`; see upstream issue [#150](https://github.com/tintinweb/pi-subagents/issues/150).
- Tool limits observe `tool_execution_start`; cancellation is asynchronous and cannot guarantee prevention of side effects from the over-budget tool. The periodic record fallback sees only completed tools.
- Resumed invocations receive fresh counters and baselines.

## Development

```bash
pnpm install --frozen-lockfile
pnpm test
```
