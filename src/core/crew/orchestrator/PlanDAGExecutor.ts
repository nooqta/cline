/**
 * PlanDAGExecutor (Phase 2 Skeleton)
 *
 * Executes a Plan (steps with dependency edges) in waves:
 *  - Each wave selects all steps whose dependencies are satisfied (status pending).
 *  - Steps in the same wave are grouped into batches by parallelGroup and dispatched
 *    to the shared ParallelExecutor with concurrency limiting.
 *  - Step lifecycle events (start / success / error) are surfaced via hooks.
 *
 * Non-goals (future phases):
 *  - Dynamic re-planning on failure
 *  - Partial retry policies / backoff
 *  - Critical path optimization
 *  - Complex resource locking
 */

import { AgentWork, ParallelExecutor } from "./ParallelExecutor"
import { Plan, PlanStep } from "./PlanTypes"

export type PlanStepEvent = "start" | "success" | "error"

export interface PlanDAGExecutorHooks {
	onStepUpdate?: (step: PlanStep, event: PlanStepEvent) => void | Promise<void>
	onWaveStart?: (waveIndex: number, steps: PlanStep[]) => void | Promise<void>
	onWaveComplete?: (waveIndex: number, steps: PlanStep[]) => void | Promise<void>
}

export interface PlanDAGExecutorOptions {
	parallelExecutor: ParallelExecutor
	hooks?: PlanDAGExecutorHooks
	// Future: termination checker, cancellation token, telemetry dispatcher
}

export interface PlanDagRunResult {
	waves: number
	stepsExecuted: number
	failedSteps: PlanStep[]
	durationMs: number
}

export type AgentRunFactory = (step: PlanStep) => AgentWork

export class PlanDAGExecutor {
	private parallelExecutor: ParallelExecutor
	private hooks?: PlanDAGExecutorHooks

	constructor(opts: PlanDAGExecutorOptions) {
		this.parallelExecutor = opts.parallelExecutor
		this.hooks = opts.hooks
	}

	/**
	 * Execute a plan to completion (or deadlock) using provided AgentWork factory.
	 * Returns summary metrics.
	 */
	async run(plan: Plan, buildWork: AgentRunFactory): Promise<PlanDagRunResult> {
		const startedAt = Date.now()
		let waves = 0
		let executed = 0

		const stepIndex = new Map<string, PlanStep>()
		plan.steps.forEach((s) => stepIndex.set(s.id, s))

		const isReady = (s: PlanStep) =>
			(s.status === "pending" || s.status === undefined) &&
			(s.dependsOn === undefined ||
				s.dependsOn.length === 0 ||
				s.dependsOn.every((d) => stepIndex.get(d)?.status === "done"))

		while (true) {
			const ready = plan.steps.filter(isReady)
			if (!ready.length) {
				// If all done or no progress possible, exit
				const remaining = plan.steps.filter((s) => s.status !== "done" && s.status !== "error")
				if (!remaining.length) break
				// Deadlock (unsatisfied deps) — mark remaining as error
				remaining.forEach((s) => {
					s.status = "error"
					s.errorMessage = "Deadlock: dependencies unresolved"
				})
				break
			}

			await this.hooks?.onWaveStart?.(waves, ready)

			// Group by parallelGroup (undefined group kept separate but combined execution is fine)
			const groups = new Map<string, PlanStep[]>()
			ready.forEach((s) => {
				const key = s.parallelGroup || "__default"
				const arr = groups.get(key) || []
				arr.push(s)
				groups.set(key, arr)
			})

			// For each group, build AgentWork items & run via ParallelExecutor
			for (const [, groupSteps] of groups) {
				// Mark steps as running and emit events
				for (const step of groupSteps) {
					step.status = "running"
					await this.hooks?.onStepUpdate?.(step, "start")
				}

				const workItems: AgentWork[] = groupSteps.map((step) => buildWork(step))
				const summary = await this.parallelExecutor.runBatch(workItems)

				// Map results back to steps
				for (const result of summary.results) {
					const step = groupSteps.find(
						(st) => st.agentId === result.agentId && (st.status === "running" || st.status === "pending"),
					)
					// Fallback attempt: match by id if agentId missing
					// (Current placeholder work ties step->agentId; future may use composite key)
					if (!step) continue
					if (result.success) {
						step.status = "done"
						await this.hooks?.onStepUpdate?.(step, "success")
					} else {
						step.status = "error"
						step.errorMessage = result.errorMessage || "Unknown error"
						await this.hooks?.onStepUpdate?.(step, "error")
					}
					executed++
				}
			}

			await this.hooks?.onWaveComplete?.(waves, ready)
			waves++
		}

		const failed = plan.steps.filter((s) => s.status === "error")
		return {
			waves,
			stepsExecuted: executed,
			failedSteps: failed,
			durationMs: Date.now() - startedAt,
		}
	}
}
