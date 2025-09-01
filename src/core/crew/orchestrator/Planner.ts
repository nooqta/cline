/**
 * Planner (Phase 2 Skeleton)
 *
 * Responsibilities:
 *  - Build a planning prompt leveraging crew goal + agent summaries + recent notes
 *  - Request structured JSON plan from LLM
 *  - Parse + minimally repair malformed JSON (similar to StructuredDecision)
 *  - Return a Plan object (PlanTypes.ts) with rationale and steps
 *
 * Non-Goals (future phases):
 *  - Cost / token budgeting
 *  - Iterative re-planning / partial plan refinement
 *  - Human approval gating
 *  - Dynamic insertion of reflection steps
 */

import { LlmChatMessage, LlmClient } from "./CrewOrchestrator"
import { Plan, PlanStep } from "./PlanTypes"
import { buildRepairInstruction as buildRouteRepairInstruction } from "./StructuredDecision"

/* ---------- Plan Decision Schema ---------- */

interface RawPlannedStep {
	id?: string
	description: string
	agentId?: string
	parallelGroup?: string
	dependsOn?: string[]
}

interface PlanDecision {
	rationale: string
	steps: RawPlannedStep[]
}

const PLAN_REQUIRED_KEYS: (keyof PlanDecision)[] = ["rationale", "steps"]

/* ---------- Prompt Construction ---------- */

export interface BuildPlanPromptCtx {
	goal: string
	crewName?: string
	agentSummaries: Array<{ id: string; role: string; parallelGroup?: string }>
	recentNotes?: string
	maxSteps?: number
}

export function buildPlanPrompt(ctx: BuildPlanPromptCtx): string {
	const agentLines =
		ctx.agentSummaries.length > 0
			? ctx.agentSummaries
					.map((a) => `- ${a.id}: role='${a.role}'${a.parallelGroup ? ` parallelGroup='${a.parallelGroup}'` : ""}`)
					.join("\n")
			: "(no agents)"
	const cap = ctx.maxSteps ?? 12
	return [
		"You are the planning module for a multi-agent crew.",
		"Produce a concise multi-step plan decomposing the goal.",
		"Return ONLY valid JSON with keys: rationale (string), steps (array).",
		`Hard cap steps: ${cap}. Omit trivial / redundant steps.`,
		"",
		"Each step object keys:",
		"  - description (required, actionable verb phrase)",
		"  - agentId (optional: choose existing agent best suited, otherwise omit)",
		"  - parallelGroup (optional: hint grouping for parallel execution, e.g. 'workers' / 'research')",
		"  - dependsOn (optional array of prior step ids)",
		"",
		"Rules:",
		"  - Assign agentId only when clearly beneficial; leave undefined if any competent agent can perform.",
		"  - Use dependsOn only when strict ordering is required.",
		"  - Prefer maximal safe parallelism (independent steps should not depend).",
		"  - Provide rationale explaining decomposition strategy & parallel grouping rationale.",
		"",
		`Goal: ${ctx.goal}`,
		`Crew: ${ctx.crewName || "unknown"}`,
		"Agents:",
		agentLines,
		ctx.recentNotes ? `Recent Notes: ${ctx.recentNotes}` : "",
		"",
		"Example JSON (do not copy blindly):",
		'{"rationale":"Decompose across data gathering then implementation.","steps":[{"id":"s1","description":"Collect API schema references","agentId":"researcher","parallelGroup":"research"},{"id":"s2","description":"Draft interface layer","agentId":"backend","dependsOn":["s1"],"parallelGroup":"workers"}]}',
	]
		.filter(Boolean)
		.join("\n")
}

/* ---------- JSON Extraction Utility (shared style) ---------- */

function extractFirstJsonObject(raw: string): string | undefined {
	const start = raw.indexOf("{")
	if (start === -1) return
	let depth = 0
	for (let i = start; i < raw.length; i++) {
		const ch = raw[i]
		if (ch === "{") depth++
		else if (ch === "}") {
			depth--
			if (depth === 0) return raw.slice(start, i + 1)
		}
	}
	return
}

/* ---------- Parsing & Validation ---------- */

function parsePlanDecision(raw: string): PlanDecision {
	const candidate = raw.trim()
	let parsed: any
	try {
		parsed = JSON.parse(candidate)
	} catch {
		const extracted = extractFirstJsonObject(candidate)
		if (!extracted) throw new Error("Plan parse error: no JSON object found.")
		parsed = JSON.parse(extracted)
	}

	for (const key of PLAN_REQUIRED_KEYS) {
		if (parsed[key] === undefined || parsed[key] === null) {
			throw new Error(`Plan validation error: missing key '${key}'.`)
		}
	}
	if (typeof parsed.rationale !== "string" || !parsed.rationale.trim()) {
		throw new Error("Plan validation error: 'rationale' must be non-empty string.")
	}
	if (!Array.isArray(parsed.steps)) {
		throw new Error("Plan validation error: 'steps' must be an array.")
	}

	const steps: RawPlannedStep[] = []
	parsed.steps.forEach((s: any, idx: number) => {
		if (!s || typeof s !== "object") {
			throw new Error(`Plan step ${idx} invalid (not an object).`)
		}
		if (typeof s.description !== "string" || !s.description.trim()) {
			throw new Error(`Plan step ${idx} missing non-empty description.`)
		}
		if (s.dependsOn && !Array.isArray(s.dependsOn)) {
			throw new Error(`Plan step ${idx} dependsOn must be an array if present.`)
		}
		steps.push({
			id: typeof s.id === "string" && s.id.trim() ? s.id.trim() : undefined,
			description: s.description.trim(),
			agentId: typeof s.agentId === "string" ? s.agentId.trim() : undefined,
			parallelGroup: typeof s.parallelGroup === "string" ? s.parallelGroup.trim() : undefined,
			dependsOn: s.dependsOn ? s.dependsOn.map((d: any) => String(d)) : undefined,
		})
	})

	return {
		rationale: parsed.rationale.trim(),
		steps,
	}
}

/* ---------- Public Planner Invocation ---------- */

export interface PlannerInvokeOptions {
	goal: string
	recentNotes?: string
	crewName?: string
	agentSummaries: Array<{ id: string; role: string; parallelGroup?: string }>
	llm: LlmClient
	maxAttempts?: number
	maxSteps?: number
	onAttempt?: (raw: string, error?: string, attempt?: number) => void | Promise<void>
}

export async function invokePlanner(opts: PlannerInvokeOptions): Promise<Plan> {
	const maxAttempts = opts.maxAttempts ?? 3
	const basePrompt = buildPlanPrompt({
		goal: opts.goal,
		crewName: opts.crewName,
		agentSummaries: opts.agentSummaries,
		recentNotes: opts.recentNotes,
		maxSteps: opts.maxSteps,
	})

	const messages: LlmChatMessage[] = [
		{ role: "system", content: "You are a precise multi-agent planner. Output only JSON." },
		{ role: "user", content: basePrompt },
	]

	let lastError: string | undefined
	let decision: PlanDecision | undefined
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const resp = await opts.llm.chat(messages, { temperature: 0 })
		const raw = resp.text || ""
		try {
			decision = parsePlanDecision(raw)
			await opts.onAttempt?.(raw, undefined, attempt)
			break
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err)
			await opts.onAttempt?.(raw, lastError, attempt)
			if (attempt < maxAttempts) {
				messages.push({ role: "assistant", content: raw })
				messages.push({
					role: "user",
					// Reuse generic repair instruction style
					content: buildRouteRepairInstruction(lastError),
				})
			}
		}
	}
	if (!decision) {
		throw new Error(`Planner: failed to obtain valid plan after ${maxAttempts} attempts. Last error: ${lastError}`)
	}

	// Normalize step ids; assign sequential if missing
	const normalizedSteps: PlanStep[] = decision.steps.map((s, idx) => ({
		id: s.id ?? `s${idx + 1}`,
		description: s.description,
		agentId: s.agentId,
		parallelGroup: s.parallelGroup,
		dependsOn: s.dependsOn || [],
		status: "pending",
	}))

	// Basic uniqueness enforcement
	const seen = new Set<string>()
	normalizedSteps.forEach((st, idx) => {
		if (seen.has(st.id)) {
			// assign deterministic fallback
			st.id = `s${idx + 1}`
		}
		seen.add(st.id)
	})

	return {
		id: `plan_${Date.now()}`,
		createdTs: Date.now(),
		rationale: decision.rationale,
		steps: normalizedSteps,
	}
}
