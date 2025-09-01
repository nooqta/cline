/**
 * Shared Plan & PlanStep type definitions extracted from CrewOrchestrator
 * to avoid circular dependencies between planner / DAG executor modules
 * and the orchestrator.
 */

export interface PlanStep {
	id: string
	description: string
	agentId?: string
	parallelGroup?: string
	dependsOn?: string[]
	status?: "pending" | "running" | "done" | "error"
	errorMessage?: string
}

export interface Plan {
	id: string
	createdTs: number
	rationale?: string
	steps: PlanStep[]
}
