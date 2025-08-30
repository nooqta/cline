/**
 * Structured decision utilities for routing and meta control decisions
 *
 * Phase 2 goal:
 *  - Provide a strict JSON decision channel the model can populate
 *  - Centralize parsing, validation, and minimal repair attempts
 *
 * Future extensions:
 *  - Generic schema registry with zod / JSON Schema
 *  - Additional decision types (replan, escalate, terminate)
 *  - Telemetry hooks for decision quality analytics
 */

export type RouteStrategy = "plan_then_parallel" | "direct_execution"

export interface RouteDecision {
	strategy: RouteStrategy
	rationale: string
}

export interface RouteDecisionContext {
	goal: string
	crewName?: string
	agentSummaries?: Array<{ id: string; role: string }>
	recentNotes?: string
}

const ROUTE_REQUIRED_KEYS: (keyof RouteDecision)[] = ["strategy", "rationale"]
const ROUTE_ALLOWED_STRATEGIES: RouteStrategy[] = ["plan_then_parallel", "direct_execution"]

/**
 * Build a concise system/user prompt segment requesting a structured route decision.
 * The model should ONLY return a JSON object with the specified keys.
 */
export function buildRouteDecisionPrompt(ctx: RouteDecisionContext): string {
	const agentLines = ctx.agentSummaries?.map((a) => `- ${a.id}: ${a.role}`).join("\n") || "(no agent summaries)"
	return [
		"You must decide the initial execution strategy for the crew.",
		"",
		"Return ONLY valid JSON with keys: strategy, rationale.",
		"Valid strategies:",
		'  - "plan_then_parallel": produce a multi-step plan first, then execute worker agents (possibly in parallel).',
		'  - "direct_execution": skip explicit multi-step plan; let agents act sequentially / opportunistically.',
		"",
		"Context:",
		`Goal: ${ctx.goal}`,
		`Crew: ${ctx.crewName || "unknown"}`,
		"Agents:",
		agentLines,
		ctx.recentNotes ? `Recent Notes: ${ctx.recentNotes}` : "",
		"",
		'Example JSON (do not include comments): {"strategy":"plan_then_parallel","rationale":"Need decomposition across backend/frontend/db."}',
	]
		.filter(Boolean)
		.join("\n")
}

/**
 * Extract first JSON object substring from raw LLM text.
 */
function extractFirstJsonObject(raw: string): string | undefined {
	const start = raw.indexOf("{")
	if (start === -1) return
	// naive balance scan
	let depth = 0
	for (let i = start; i < raw.length; i++) {
		const ch = raw[i]
		if (ch === "{") depth++
		else if (ch === "}") {
			depth--
			if (depth === 0) {
				return raw.slice(start, i + 1)
			}
		}
	}
	return
}

/**
 * Parse a routed decision JSON with strict validation. Throws on failure.
 * Performs minimal repair attempts (JSON extraction).
 */
export function parseRouteDecision(raw: string): RouteDecision {
	const candidate = raw.trim()
	let parsed: any

	// Attempt direct parse first
	try {
		parsed = JSON.parse(candidate)
	} catch {
		// Try to extract JSON object substring
		const extracted = extractFirstJsonObject(candidate)
		if (!extracted) {
			throw new Error("RouteDecision parse error: no JSON object found.")
		}
		try {
			parsed = JSON.parse(extracted)
		} catch (err) {
			throw new Error("RouteDecision parse error: invalid JSON structure.")
		}
	}

	// Validate required keys
	for (const key of ROUTE_REQUIRED_KEYS) {
		if (parsed[key] === undefined || parsed[key] === null) {
			throw new Error(`RouteDecision validation error: missing key '${key}'.`)
		}
	}

	// Normalize strategy
	if (typeof parsed.strategy !== "string") {
		throw new Error("RouteDecision validation error: 'strategy' must be a string.")
	}
	const strat = parsed.strategy.trim() as RouteStrategy
	if (!ROUTE_ALLOWED_STRATEGIES.includes(strat)) {
		throw new Error(`RouteDecision validation error: 'strategy' must be one of ${ROUTE_ALLOWED_STRATEGIES.join(", ")}.`)
	}

	// Rationale
	if (typeof parsed.rationale !== "string" || !parsed.rationale.trim()) {
		throw new Error("RouteDecision validation error: 'rationale' must be a non-empty string.")
	}

	return {
		strategy: strat,
		rationale: parsed.rationale.trim(),
	}
}

/**
 * Generic structured decision helper for future schemas.
 * Minimal key / type gate — can be replaced by a schema validator (zod / ajv) later.
 */
export function parseStructured<T extends Record<string, any>>(raw: string, requiredKeys: (keyof T)[]): T {
	const candidate = raw.trim()
	let parsed: any
	try {
		parsed = JSON.parse(candidate)
	} catch {
		const extracted = extractFirstJsonObject(candidate)
		if (!extracted) throw new Error("Structured parse error: no JSON object found.")
		parsed = JSON.parse(extracted)
	}
	for (const key of requiredKeys) {
		if (parsed[key as string] === undefined) {
			throw new Error(`Structured parse error: missing key '${String(key)}'`)
		}
	}
	return parsed as T
}

/**
 * Render a concise error + repair instruction to feed back to the model when parsing fails.
 */
export function buildRepairInstruction(errorMessage: string): string {
	return [
		"Your previous response could not be parsed as valid JSON for the required decision schema.",
		`Error: ${errorMessage}`,
		"Return ONLY a JSON object matching the required keys. No commentary. No markdown fencing.",
	].join("\n")
}
