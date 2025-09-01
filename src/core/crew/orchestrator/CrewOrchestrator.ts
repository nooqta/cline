/**
 * CrewOrchestrator (Phase 2 Skeleton)
 *
 * Responsibilities (current skeleton):
 *  - Load selected crew & execution policies from global state.
 *  - Obtain an initial routing decision (plan_then_parallel | direct_execution)
 *    using StructuredDecision utilities with a repair loop.
 *  - Instantiate foundational utilities:
 *      * ToolAllowlistEnforcer
 *      * ParallelExecutor (not yet fully wired to agent step execution)
 *      * Checkpoint tagging wrapper (commit message metadata)
 *  - Provide placeholder branches for:
 *      * direct execution strategy
 *      * plan-then-parallel strategy
 *
 * NOT implemented yet (future phases):
 *  - Planner agent invocation & plan representation
 *  - Worker agent step execution (LLM + tools + observation accumulation)
 *  - Reflection / reviewer cycle & termination predicates
 *  - Per-agent state projection / merge
 *  - Human approval gates (plan / reflection)
 *  - Tool invocation dispatch + integration with existing Task/ToolExecutor
 *
 * This file is intentionally self-contained to reduce coupling until concrete
 * integration points with existing task loop are finalized.
 */

import type { Crew, CrewAgent, CrewExecutionPolicies } from "@/shared/Crew"
import { createCheckpointTagWrapper } from "./CheckpointTagging"
import { AgentWork, ParallelBatchSummary, ParallelExecutor } from "./ParallelExecutor"
import { PlanDAGExecutor } from "./PlanDAGExecutor"
import { invokePlanner } from "./Planner"
import { Plan, PlanStep } from "./PlanTypes"
import { ShortTermMemory } from "./ShortTermMemory"
import { buildRepairInstruction, buildRouteDecisionPrompt, parseRouteDecision, RouteDecision } from "./StructuredDecision"
import { buildPoliciesFromAgents, ToolAllowlistEnforcer } from "./ToolAllowlist"

/* ========== Termination Reason Enum ========== */
export enum TerminationReason {
	MAX_AGENT_LOOPS = "MAX_AGENT_LOOPS",
	MAX_REFLECTION_CYCLES = "MAX_REFLECTION_CYCLES",
	MANUAL_HUMAN_ABORT = "MANUAL_HUMAN_ABORT",
	MODEL_SAYS_DONE = "MODEL_SAYS_DONE",
	POLICY_DENY = "POLICY_DENY",
}

/* ========== Lightweight LLM Abstraction ========== */

export interface LlmChatMessage {
	role: "system" | "user" | "assistant"
	content: string
}

export interface LlmResponse {
	text: string
}

export interface LlmClient {
	chat(messages: LlmChatMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<LlmResponse>
}

/* ========== Orchestrator Configuration & Result Types ========== */

export interface CrewOrchestratorConfig {
	llm: LlmClient
	getGlobalState: <T = any>(key: string) => T | undefined
	checkpointTracker?: { commit: (messagePrefix?: string) => Promise<string | undefined> }
	routeDecisionMaxAttempts?: number
	// Telemetry hooks
	onRouteDecisionAttempt?: (raw: string, error?: string, attempt?: number) => void | Promise<void>
	onParallelBatchComplete?: (summary: ParallelBatchSummary) => void | Promise<void>
	onPlanAttempt?: (raw: string, error?: string, attempt?: number) => void | Promise<void>
	onPlanGenerated?: (plan: Plan, generatedVia: "planner" | "skeleton") => void | Promise<void>
	onPlanStepUpdate?: (step: PlanStep, event: "start" | "success" | "error") => void | Promise<void>
	onPlanWaveComplete?: (waveIndex: number, steps: PlanStep[]) => void | Promise<void>
}

export interface OrchestratorRunOptions {
	goal: string
	recentNotes?: string
	// Future: conversation excerpt, prior plan summary, user constraints, etc.
}

export interface OrchestratorRunResult {
	strategy: RouteDecision["strategy"]
	routeDecision: RouteDecision
	planGenerated?: boolean
	plan?: Plan
	parallelBatchesExecuted?: number
	terminationEarly?: boolean
	terminationReason?: TerminationReason
	terminationDetail?: string
	notes?: string
	// Future: plan object, reflection summary, termination reason, checkpoints metadata
}

/* ========== Plan Types ==========
 * Moved to PlanTypes.ts for shared usage (planner, DAG executor, orchestrator).
 */

/* ========== Termination State (runtime-only) ========== */

interface TerminationState {
	agentLoopCounts: Record<string, number>
	reflectionCycles: number
	terminated: boolean
	reason?: TerminationReason
	terminationDetail?: string
}

/* ========== Orchestrator Class ========== */

export class CrewOrchestrator {
	private cfg: CrewOrchestratorConfig
	private crew: Crew | undefined
	private executionPolicies: CrewExecutionPolicies | undefined
	private allowlist: ToolAllowlistEnforcer | undefined
	private parallelExecutor: ParallelExecutor | undefined
	private termination: TerminationState = {
		agentLoopCounts: {},
		reflectionCycles: 0,
		terminated: false,
	}
	private memory = new ShortTermMemory()

	constructor(cfg: CrewOrchestratorConfig) {
		this.cfg = {
			routeDecisionMaxAttempts: 3,
			...cfg,
		}
		this.initializeCrewContext()
	}

	/**
	 * Load selected crew + build foundational utility instances.
	 */
	private initializeCrewContext() {
		const crews = (this.cfg.getGlobalState("crews") as Crew[] | undefined) || []
		const selectedCrewId = this.cfg.getGlobalState("selectedCrewId") as string | undefined
		this.crew = crews.find((c) => c.id === selectedCrewId) || crews.find((c) => c.default) || crews[0]
		if (!this.crew) {
			return
		}
		this.executionPolicies = this.crew.executionPolicies
		this.allowlist = new ToolAllowlistEnforcer(buildPoliciesFromAgents(this.crew.agents))
		const maxConcurrent =
			this.executionPolicies?.parallel?.maxConcurrentAgents && this.executionPolicies.parallel.maxConcurrentAgents > 0
				? this.executionPolicies.parallel.maxConcurrentAgents
				: 1
		const checkpointWrapper = createCheckpointTagWrapper(this.cfg.checkpointTracker)
		this.parallelExecutor = new ParallelExecutor({
			maxConcurrent,
			onFinishBatch: (summary) => this.cfg.onParallelBatchComplete?.(summary),
			withCheckpointTag: checkpointWrapper,
		})
	}

	/**
	 * Public entrypoint: executes a full orchestrator run for the supplied goal.
	 * For now, this focuses on obtaining the route strategy and the skeleton of execution.
	 */
	async run(options: OrchestratorRunOptions): Promise<OrchestratorRunResult> {
		if (!this.crew) {
			throw new Error("CrewOrchestrator: No crew available in global state.")
		}

		const routeDecision = await this.acquireRouteDecision(options)
		let planGenerated = false
		let plan: Plan | undefined
		let parallelBatchesExecuted = 0
		let terminationEarly = false
		let terminationReason: TerminationReason | undefined
		let terminationDetail: string | undefined

		switch (routeDecision.strategy) {
			case "plan_then_parallel": {
				const agentSummaries = this.crew.agents.map((a) => ({
					id: a.id,
					role: a.role || a.id,
					parallelGroup: (a as any).parallelGroup,
				}))
				try {
					plan = await invokePlanner({
						goal: options.goal,
						recentNotes: options.recentNotes,
						crewName: this.crew.name,
						agentSummaries,
						llm: this.cfg.llm,
						onAttempt: this.cfg.onPlanAttempt,
					})
					planGenerated = true
					await this.cfg.onPlanGenerated?.(plan, "planner")
					this.memory.appendThought(`Planner produced ${plan.steps.length} steps.`)
					if (plan.rationale) this.memory.appendThought(`Plan rationale: ${plan.rationale.substring(0, 200)}`)
				} catch (err) {
					// Fallback to skeleton plan
					plan = this.generateSkeletonPlan(options.goal)
					planGenerated = true
					await this.cfg.onPlanGenerated?.(plan, "skeleton")
					if (plan.rationale) this.memory.appendThought(`Fallback plan rationale: ${plan.rationale.substring(0, 200)}`)
					this.memory.appendObservation({ content: "Planner failed, using skeleton plan fallback", success: false })
				}
				parallelBatchesExecuted = await this.executePlanThenParallel(plan)
				break
			}
			case "direct_execution": {
				parallelBatchesExecuted = await this.executeDirectExecution()
				break
			}
			default:
				throw new Error(`CrewOrchestrator: Unsupported strategy ${routeDecision.strategy}`)
		}

		if (this.termination.terminated) {
			terminationEarly = true
			terminationReason = this.termination.reason
			terminationDetail = this.termination.terminationDetail
		}

		return {
			strategy: routeDecision.strategy,
			routeDecision,
			planGenerated,
			plan,
			parallelBatchesExecuted,
			terminationEarly,
			terminationReason,
			terminationDetail,
			notes: "Skeleton execution path complete (no actual agent steps yet).",
		}
	}

	/* ========== Route Decision Acquisition ========== */

	private async acquireRouteDecision(options: OrchestratorRunOptions): Promise<RouteDecision> {
		const maxAttempts = this.cfg.routeDecisionMaxAttempts || 3
		const agentsSummary = this.crew?.agents.map((a) => ({ id: a.id, role: a.role })) || []
		const basePrompt = buildRouteDecisionPrompt({
			goal: options.goal,
			crewName: this.crew?.name,
			agentSummaries: agentsSummary,
			recentNotes: options.recentNotes,
		})

		// Strategy: single system+user message combined (simplified). Future: augment with system role.
		const messages: LlmChatMessage[] = [
			{ role: "system", content: "You are an orchestration assistant optimizing multi-agent strategies." },
			{ role: "user", content: basePrompt },
		]

		let lastError: string | undefined
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const response = await this.cfg.llm.chat(messages, { temperature: 0 })
			const raw = response.text || ""
			try {
				const decision = parseRouteDecision(raw)
				await this.cfg.onRouteDecisionAttempt?.(raw, undefined, attempt)
				return decision
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err)
				await this.cfg.onRouteDecisionAttempt?.(raw, lastError, attempt)
				if (attempt < maxAttempts) {
					messages.push({
						role: "assistant",
						content: raw,
					})
					messages.push({
						role: "user",
						content: buildRepairInstruction(lastError),
					})
				}
			}
		}
		throw new Error(
			`CrewOrchestrator: Failed to parse route decision after ${maxAttempts} attempts. Last error: ${lastError}`,
		)
	}

	/* ========== Strategy Branch Placeholders ========== */

	/**
	 * Direct execution placeholder:
	 *  - Future: spawn a sequential (or limited parallel) set of worker agent steps without explicit planning.
	 */
	private async executeDirectExecution(): Promise<number> {
		if (this.checkTermination()) return 0
		if (!this.crew) return 0
		if (!this.parallelExecutor) return 0

		// For skeleton: choose enabled non-reflection agents as a single trivial batch (no real work).
		const workAgents = this.crew.agents.filter((a) => a.enabled !== false && !a.reflectionRole)
		if (!workAgents.length) return 0

		const fakeWork: AgentWork[] = workAgents.map((agent) => ({
			agentId: agent.id,
			phase: "execution",
			input: undefined,
			label: "skeleton-step",
			run: async () => ({
				agentId: agent.id,
				phase: "execution",
				success: true,
				output: { placeholder: true },
				startedAt: Date.now(),
				finishedAt: Date.now(),
			}),
		}))

		await this.parallelExecutor.runBatch(fakeWork)
		this.memory.appendObservation({
			content: `Executed direct batch with ${fakeWork.length} placeholder steps`,
			success: true,
		})
		if (this.checkTermination()) return 1
		return 1
	}

	/**
	 * Plan then parallel execution placeholder:
	 *  - Future: call planner agent to generate plan steps.
	 *  - Partition plan steps by agent parallelGroup or role, feed into ParallelExecutor batches.
	 */
	private async executePlanThenParallel(plan: Plan): Promise<number> {
		if (this.checkTermination()) return 0
		if (!this.crew) return 0
		if (!this.parallelExecutor) return 0
		if (!plan.steps.length) return 0

		// Build DAG executor with hooks mapping to config + memory
		const dag = new PlanDAGExecutor({
			parallelExecutor: this.parallelExecutor,
			hooks: {
				onStepUpdate: async (step, event) => {
					if (event === "start") this.memory.appendThought(`Step ${step.id} started`)
					else if (event === "success")
						this.memory.appendObservation({
							content: `Step ${step.id} completed: ${step.description}`,
							success: true,
						})
					else if (event === "error")
						this.memory.appendObservation({ content: `Step ${step.id} failed: ${step.errorMessage}`, success: false })
					await this.cfg.onPlanStepUpdate?.(step, event)
				},
				onWaveComplete: async (waveIndex, steps) => {
					await this.cfg.onPlanWaveComplete?.(waveIndex, steps)
					this.memory.appendThought(`Wave ${waveIndex} complete (${steps.length} steps).`)
				},
			},
		})

		// Default agent assignment fallback: first non-reflection enabled agent
		const defaultAgent = this.crew.agents.find((a) => a.enabled !== false && !a.reflectionRole)
		const buildWork = (step: PlanStep): AgentWork => {
			if (!step.agentId && defaultAgent) {
				step.agentId = defaultAgent.id // mutate for matching
			}
			const agentId = step.agentId || "unassigned"
			return {
				agentId,
				phase: "execution",
				input: undefined,
				label: step.description,
				run: async () => ({
					agentId,
					phase: "execution",
					success: true,
					output: { placeholder: "planned-exec", stepId: step.id },
					startedAt: Date.now(),
					finishedAt: Date.now(),
				}),
			}
		}

		const result = await dag.run(plan, buildWork)
		// Post-execution summary memory entry
		const doneCount = plan.steps.filter((s) => s.status === "done").length
		const errorCount = plan.steps.filter((s) => s.status === "error").length
		this.memory.appendThought(`Plan execution summary: ${doneCount} done, ${errorCount} error, ${result.waves} waves.`)
		// One "batch" per wave conceptually; return waves count
		return result.waves
	}

	/* ========== Termination Enforcement (scaffold) ========== */

	/**
	 * Increment loop count for an agent; returns false if limit exceeded and sets termination.
	 */
	incrementAgentLoop(agentId: string): boolean {
		const maxLoops = this.executionPolicies?.termination?.maxAgentLoops
		if (this.termination.terminated) return false
		this.termination.agentLoopCounts[agentId] = (this.termination.agentLoopCounts[agentId] || 0) + 1
		if (maxLoops && this.termination.agentLoopCounts[agentId] > maxLoops) {
			this.setTerminated(TerminationReason.MAX_AGENT_LOOPS, `agent ${agentId} exceeded maxAgentLoops (${maxLoops})`)
			return false
		}
		return true
	}

	/**
	 * Increment reflection cycle counter; returns false if exceeded.
	 */
	incrementReflectionCycle(): boolean {
		const maxReflections = this.executionPolicies?.termination?.maxReflectionCycles
		if (this.termination.terminated) return false
		this.termination.reflectionCycles += 1
		if (maxReflections && this.termination.reflectionCycles > maxReflections) {
			this.setTerminated(TerminationReason.MAX_REFLECTION_CYCLES, `exceeded maxReflectionCycles (${maxReflections})`)
			return false
		}
		return true
	}

	private setTerminated(reason: TerminationReason, detail?: string) {
		if (!this.termination.terminated) {
			this.termination.terminated = true
			this.termination.reason = reason
			if (detail) this.termination.terminationDetail = detail
		}
	}

	/**
	 * Quick check to gate future execution branches.
	 */
	private checkTermination(): boolean {
		return this.termination.terminated
	}

	/* ========== Plan Generation (skeleton) ========== */

	/**
	 * Temporary skeleton plan generator:
	 *  - Creates one step per eligible worker agent.
	 *  - Marks parallelGroup from agent if present to hint future batching.
	 */
	private generateSkeletonPlan(goal: string): Plan {
		if (!this.crew) {
			return { id: "plan_none", createdTs: Date.now(), steps: [], rationale: "No crew" }
		}
		const steps: PlanStep[] = this.crew.agents
			.filter((a) => a.enabled !== false && !a.reflectionRole)
			.map((a, idx) => ({
				id: `step_${idx + 1}_${a.id}`,
				description: `Have agent '${a.role || a.id}' contribute toward goal: ${goal}`,
				agentId: a.id,
				parallelGroup: a.parallelGroup,
				dependsOn: [],
				status: "pending",
			}))
		return {
			id: `plan_${Date.now()}`,
			createdTs: Date.now(),
			rationale: "Skeleton auto-generated plan (no real planner yet).",
			steps,
		}
	}

	/* ========== Reflection Hook (placeholder) ========== */

	/**
	 * Placeholder reflection pass hook.
	 * Future: invoke reflection/reviewer agent, analyze recent observations,
	 * possibly modify plan or terminate with MODEL_SAYS_DONE / POLICY_DENY.
	 */
	async runReflectionPassPlaceholder(): Promise<void> {
		if (this.termination.terminated) return
		// For now simply attempt to increment reflection cycle respecting limits.
		this.incrementReflectionCycle()
		this.memory.appendThought("Reflection placeholder invoked")
	}

	/* ========== Utility Accessors (future integration points) ========== */

	getSelectedCrew(): Crew | undefined {
		return this.crew
	}

	getAllowlist(): ToolAllowlistEnforcer | undefined {
		return this.allowlist
	}

	getExecutionPolicies(): CrewExecutionPolicies | undefined {
		return this.executionPolicies
	}

	getShortTermMemory(): ShortTermMemory {
		return this.memory
	}
}

/* ========== Factory ========== */

export function createCrewOrchestrator(cfg: CrewOrchestratorConfig): CrewOrchestrator {
	return new CrewOrchestrator(cfg)
}

/**
 * TODO (future phases):
 *  - Inject planner/reviewer agent executors (LLM + system prompts + tool contexts)
 *  - Integrate real tool invocation pipeline with ToolAllowlistEnforcer enforcement
 *  - Reflection cycle & termination predicate evaluation loop
 *  - Plan data model (steps, dependencies, statuses)
 *  - Memory stratification (ephemeral vs curated long-term)
 *  - Approval gates referencing executionPolicies.approvals
 *  - Error handling & retry budgets
 *  - Telemetry / instrumentation events
 */
