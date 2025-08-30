/**
 * ToolInvocation pipeline (Phase 1 foundational)
 *
 * Purpose:
 *  - Standardize how the orchestrator (planner / worker / reflection) will
 *    request tool executions and receive normalized observations.
 *  - Provide lightweight placeholder executor to be replaced with real
 *    integration (Task / existing tool execution framework) in later phases.
 *
 * Design Notes:
 *  - Separation between the *request* (what model decided) and the *execution result*
 *    (raw outcome) and the *structured observation* (normalized form fed back to LLM loops).
 *  - Allows future enrichment (timing, cost, safety flags) without disturbing callers.
 *  - Supports both success and error flows uniformly.
 */

export type ToolCallPhase = "planning" | "execution" | "reflection"

export interface ToolCallRequest {
	id: string // Unique per request (e.g. ulid)
	toolId: string // Canonical tool identifier
	agentId: string // Originating agent
	phase: ToolCallPhase
	input: unknown // Model-proposed raw input (to be validated)
	requestedAt: number
	// Future: schemaVersion, safetyContext, retryAttempt, correlationId
}

export interface ToolExecutionResult {
	requestId: string
	toolId: string
	agentId: string
	phase: ToolCallPhase
	startedAt: number
	finishedAt: number
	durationMs: number
	success: boolean
	output?: unknown // Raw tool output (before normalization)
	errorType?: string
	errorMessage?: string
	// Future: retryable flag, cost metrics, token usage
}

export interface StructuredObservation {
	requestId: string
	toolId: string
	agentId: string
	phase: ToolCallPhase
	success: boolean
	summary: string // Short textual summary for LLM context window
	data?: unknown // Optional trimmed/structured data
	errorType?: string
	errorMessage?: string
	// Future: importance score, memoryRetentionHint, serialization size stats
}

/**
 * Interface for an executor implementation.
 * Real implementation will:
 *  - Validate input against tool schema
 *  - Enforce allowlist
 *  - Execute tool (async)
 *  - Capture timing / normalize output
 *  - Map errors to standardized categories
 */
export interface ToolExecutor {
	execute(request: ToolCallRequest): Promise<ToolExecutionResult>
}

/**
 * Normalizer converts execution results into observations consumable by LLM loops.
 */
export interface ToolObservationBuilder {
	build(result: ToolExecutionResult): StructuredObservation
}

/* ===============================
 * Placeholder Implementations
 * =============================== */

/**
 * No-op executor placeholder that simulates success.
 * Replace with integration to actual tool subsystem.
 */
export class NoopToolExecutor implements ToolExecutor {
	async execute(request: ToolCallRequest): Promise<ToolExecutionResult> {
		const started = Date.now()
		// Simulated latency
		await new Promise((r) => setTimeout(r, 5))
		const finished = Date.now()
		return {
			requestId: request.id,
			toolId: request.toolId,
			agentId: request.agentId,
			phase: request.phase,
			startedAt: started,
			finishedAt: finished,
			durationMs: finished - started,
			success: true,
			output: { placeholder: true, echoInput: request.input },
		}
	}
}

/**
 * Basic observation builder that truncates JSON outputs and errors.
 */
export class BasicToolObservationBuilder implements ToolObservationBuilder {
	constructor(private maxJsonLength = 400) {}

	build(result: ToolExecutionResult): StructuredObservation {
		if (!result.success) {
			return {
				requestId: result.requestId,
				toolId: result.toolId,
				agentId: result.agentId,
				phase: result.phase,
				success: false,
				summary: `Tool ${result.toolId} failed (${result.errorType || "error"})`,
				errorType: result.errorType,
				errorMessage: this.truncate(result.errorMessage),
			}
		}
		const serialized = this.safeStringify(result.output)
		return {
			requestId: result.requestId,
			toolId: result.toolId,
			agentId: result.agentId,
			phase: result.phase,
			success: true,
			summary: `Tool ${result.toolId} success`,
			data: this.truncate(serialized),
		}
	}

	private safeStringify(obj: unknown): string {
		try {
			return JSON.stringify(obj)
		} catch {
			return "[unserializable]"
		}
	}

	private truncate(str?: string): string | undefined {
		if (!str) return str
		if (str.length <= this.maxJsonLength) return str
		return str.slice(0, this.maxJsonLength) + "...[truncated]"
	}
}

/* ===============================
 * Orchestrator Integration Sketch
 * ===============================
 *
 * Future wiring steps (not implemented here):
 * 1. CrewOrchestrator obtains ToolExecutor + ToolObservationBuilder instances (DI).
 * 2. When an agent decides a tool call, construct ToolCallRequest and pass through executor.
 * 3. Push StructuredObservation into ShortTermMemory buffer.
 * 4. Reflection / planner loops consume recent observations.
 * 5. Termination checks may examine failed observation counts.
 *
 * This skeleton intentionally keeps responsibilities isolated for incremental adoption.
 */
