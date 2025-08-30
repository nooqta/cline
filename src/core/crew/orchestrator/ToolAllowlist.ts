/**
 * Tool Allowlist Enforcement (Phase 2 Stub)
 *
 * Purpose:
 *  - Enforce per-agent explicit tool allowlists (security + deterministic behavior)
 *  - Provide guard utilities the orchestrator / dispatcher can call before invoking a tool
 *  - Central place to extend future policies (denylist, capability classes, rate limits)
 *
 * Assumptions:
 *  - Agent definitions may include allowedToolIds?: string[]
 *  - If allowedToolIds is undefined or empty => permissive (backward compatible)
 *  - Tool identifiers align with existing internal tool names / MCP tool naming convention
 *
 * Future Extensions (Phase 3+):
 *  - Capability classification (read_fs, write_fs, net_access)
 *  - Policy reasoning traces (why a tool was blocked)
 *  - Dynamic allowlist widening via human approval
 *  - Per-phase differentiation (planning vs execution vs reflection)
 */

export interface ToolInvocationContext {
	agentId: string
	phase: "planning" | "execution" | "reflection"
	toolName: string
	// Optional additional metadata (e.g., provider, MCP server id, args summary)
	meta?: Record<string, any>
}

export interface AgentToolPolicy {
	agentId: string
	allowedToolIds?: string[] // undefined/empty => allow all
}

export interface AllowlistDecision {
	allowed: boolean
	reason?: string
}

export class ToolAllowlistEnforcer {
	private policyMap: Map<string, AgentToolPolicy>

	constructor(policies: AgentToolPolicy[]) {
		this.policyMap = new Map(policies.map((p) => [p.agentId, p]))
	}

	/**
	 * Check whether a tool invocation is permitted for the agent.
	 * Returns an AllowlistDecision (never throws).
	 */
	check(ctx: ToolInvocationContext): AllowlistDecision {
		const policy = this.policyMap.get(ctx.agentId)
		if (!policy) {
			// No explicit policy object => allow (fallback)
			return { allowed: true }
		}
		const list = policy.allowedToolIds || []
		if (list.length === 0) {
			// Empty/undefined list => allow all (backward compat)
			return { allowed: true }
		}
		if (list.includes(ctx.toolName)) {
			return { allowed: true }
		}
		return {
			allowed: false,
			reason: `Tool '${ctx.toolName}' not in allowlist for agent '${ctx.agentId}'.`,
		}
	}

	/**
	 * Enforce with exception (for callers that prefer throwing).
	 */
	enforce(ctx: ToolInvocationContext): void {
		const decision = this.check(ctx)
		if (!decision.allowed) {
			throw new Error(decision.reason || "Tool invocation blocked by allowlist.")
		}
	}

	/**
	 * Update (replace) policy for an agent at runtime (e.g., after user edits crew).
	 */
	upsertPolicy(policy: AgentToolPolicy) {
		this.policyMap.set(policy.agentId, policy)
	}

	/**
	 * Remove policy (agent deletion).
	 */
	removePolicy(agentId: string) {
		this.policyMap.delete(agentId)
	}

	listPolicies(): AgentToolPolicy[] {
		return Array.from(this.policyMap.values())
	}
}

/**
 * Helper to build policies from crew agent definitions.
 */
export function buildPoliciesFromAgents(agents: Array<{ id: string; allowedToolIds?: string[] }>): AgentToolPolicy[] {
	return agents.map((a) => ({
		agentId: a.id,
		allowedToolIds: a.allowedToolIds && a.allowedToolIds.length ? [...a.allowedToolIds] : undefined,
	}))
}

/**
 * Lightweight wrapper to execute a tool with allowlist enforcement.
 * (Integration point: central dispatcher that currently routes tool calls.)
 */
export async function withToolAllowlist<T>(
	enforcer: ToolAllowlistEnforcer,
	ctx: ToolInvocationContext,
	fn: () => Promise<T>,
): Promise<T> {
	enforcer.enforce(ctx)
	return fn()
}

/**
 * TODO (future):
 *  - Add rate limiting metadata (counts, time windows)
 *  - Capability-based expansion: map toolName -> capability set; enforce capability allowlist
 *  - Emit telemetry events on blocked usage
 *  - Provide suggestion hints for missing tools (e.g., similar name detection)
 */
