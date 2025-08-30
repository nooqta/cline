/**
 * Parallel Executor (Phase 2)
 *
 * Provides a lightweight promise pool for executing agent batches with a concurrency cap.
 * Integration targets:
 *  - Crew orchestrator will transform plan / work items into AgentWork units.
 *  - Each work unit runs an agent step (LLM + optional tools) and returns an AgentWorkResult.
 *  - Tool allowlist enforcement occurs BEFORE invoking the agent's tool dispatch (see ToolAllowlist.ts).
 *  - Checkpoint tagging: wrap each work unit to annotate commits with { agentId, phase } (see CheckpointTagging.ts).
 *
 * Non-goals (future phases):
 *  - Dynamic rebalancing
 *  - Cancellation graph propagation
 *  - Weighted priority scheduling
 *  - Retry policies (will come with Reflection / remediation cycle)
 */

export interface AgentWork<Input = any> {
	agentId: string
	phase: "planning" | "execution" | "reflection"
	input: Input
	// Optional label for grouping / telemetry
	label?: string
	// Execution function returning a result payload
	run: () => Promise<AgentWorkResult<any>>
}

export interface AgentWorkResult<Output = any> {
	agentId: string
	phase: "planning" | "execution" | "reflection"
	success: boolean
	output?: Output
	errorMessage?: string
	startedAt: number
	finishedAt: number
}

export interface ParallelBatchSummary {
	results: AgentWorkResult[]
	succeeded: AgentWorkResult[]
	failed: AgentWorkResult[]
	durationMs: number
}

export interface ParallelExecutorOptions {
	maxConcurrent: number
	// Optional hook invoked once a work item completes (streaming status)
	onResult?: (result: AgentWorkResult) => void | Promise<void>
	// Optional hook invoked when queue starts (telemetry)
	onStartBatch?: (total: number) => void | Promise<void>
	// Optional hook invoked when batch finishes
	onFinishBatch?: (summary: ParallelBatchSummary) => void | Promise<void>
	// Optional per-task checkpoint tagging wrapper (phase 2 stub)
	withCheckpointTag?: <T>(agentId: string, phase: string, fn: () => Promise<T>) => Promise<T>
}

export class ParallelExecutor {
	private readonly maxConcurrent: number
	private readonly onResult?: ParallelExecutorOptions["onResult"]
	private readonly onStartBatch?: ParallelExecutorOptions["onStartBatch"]
	private readonly onFinishBatch?: ParallelExecutorOptions["onFinishBatch"]
	private readonly withCheckpointTag?: ParallelExecutorOptions["withCheckpointTag"]

	constructor(opts: ParallelExecutorOptions) {
		if (opts.maxConcurrent < 1) {
			throw new Error("ParallelExecutor: maxConcurrent must be >= 1")
		}
		this.maxConcurrent = opts.maxConcurrent
		this.onResult = opts.onResult
		this.onStartBatch = opts.onStartBatch
		this.onFinishBatch = opts.onFinishBatch
		this.withCheckpointTag = opts.withCheckpointTag
	}

	/**
	 * Execute a batch of agent work items respecting concurrency.
	 * Returns when all work completed (success or failure).
	 */
	async runBatch(workItems: AgentWork[]): Promise<ParallelBatchSummary> {
		const queue = [...workItems]
		const inFlight: Promise<void>[] = []
		const results: AgentWorkResult[] = []
		const startedAt = Date.now()

		await this.onStartBatch?.(queue.length)

		const launchNext = () => {
			if (!queue.length) return
			const item = queue.shift()!
			const p = this.executeItem(item)
				.then((res) => {
					results.push(res)
					return this.onResult?.(res)
				})
				.catch((err) => {
					// Should not throw; capture as failed result
					const now = Date.now()
					;(results as AgentWorkResult[]).push({
						agentId: item.agentId,
						phase: item.phase,
						success: false,
						errorMessage: err instanceof Error ? err.message : String(err),
						startedAt: now,
						finishedAt: now,
					})
				})
				.finally(() => {
					// Remove self from inFlight
					const idx = inFlight.indexOf(p)
					if (idx !== -1) inFlight.splice(idx, 1)
					// Launch next if remaining
					if (queue.length) {
						launchNext()
					}
				})
			inFlight.push(p)
		}

		// Prime initial pool
		const initial = Math.min(this.maxConcurrent, queue.length)
		for (let i = 0; i < initial; i++) {
			launchNext()
		}

		// Await completion
		await Promise.all(inFlight)

		const durationMs = Date.now() - startedAt
		const summary: ParallelBatchSummary = {
			results,
			succeeded: results.filter((r) => r.success),
			failed: results.filter((r) => !r.success),
			durationMs,
		}

		await this.onFinishBatch?.(summary)
		return summary
	}

	private async executeItem(item: AgentWork): Promise<AgentWorkResult> {
		const startedAt = Date.now()
		try {
			const runFn = async () => item.run()
			const wrapped = this.withCheckpointTag ? await this.withCheckpointTag(item.agentId, item.phase, runFn) : await runFn()
			const finishedAt = Date.now()
			return {
				agentId: item.agentId,
				phase: item.phase,
				success: wrapped.success,
				output: wrapped.output,
				errorMessage: wrapped.errorMessage,
				startedAt,
				finishedAt,
			}
		} catch (error) {
			const finishedAt = Date.now()
			return {
				agentId: item.agentId,
				phase: item.phase,
				success: false,
				errorMessage: error instanceof Error ? error.message : String(error),
				startedAt,
				finishedAt,
			}
		}
	}
}

/**
 * Helper to create work items from a simple function map.
 */
export function buildAgentWork<TInput, TOutput>(
	agentId: string,
	phase: AgentWork["phase"],
	fn: () => Promise<TOutput>,
): AgentWork {
	return {
		agentId,
		phase,
		input: undefined,
		run: async () => {
			try {
				const output = await fn()
				return {
					agentId,
					phase,
					success: true,
					output,
					startedAt: Date.now(), // overwritten by executor
					finishedAt: Date.now(), // overwritten by executor
				}
			} catch (err) {
				return {
					agentId,
					phase,
					success: false,
					errorMessage: err instanceof Error ? err.message : String(err),
					startedAt: Date.now(),
					finishedAt: Date.now(),
				}
			}
		},
	}
}

/**
 * TODO (future):
 *  - Add timeout support per work item
 *  - Add retry + backoff policy
 *  - Integrate reflection signals to regenerate failed items selectively
 *  - Expose fine-grained progress events (percent complete, ETA)
 */
