export type AgentExecutionMode = "single" | "crew"

export interface CrewAgent {
	id: string
	name: string
	role: string
	description?: string
	defaultMcpServers: string[] | "all"
	modelProvider?: string
	modelId?: string
	enabled?: boolean
	// Optional explicit allowlist of tool IDs (derived from MCP servers + internal tools)
	allowedToolIds?: string[]
	// Optional grouping label for parallel batch execution
	parallelGroup?: string
	// Marks this agent as a reviewer / reflection role
	reflectionRole?: boolean
}

export interface CrewExecutionPolicies {
	termination?: {
		maxAgentLoops?: number
		maxReflectionCycles?: number
		confidenceKey?: string
		requireReviewerApproval?: boolean
	}
	approvals?: {
		requirePlanApproval?: boolean
		requireReflectionGate?: boolean
	}
	parallel?: {
		maxConcurrentAgents?: number
	}
}

export interface CrewProviderConfig {
	provider?: string
	modelId?: string
	mcpServerIds?: string[]
	extra?: Record<string, string>
}

export interface Crew {
	id: string
	name: string
	description?: string
	architecture: string
	agents: CrewAgent[]
	default?: boolean
	tags?: string[]
	createdTs: number
	updatedTs: number
	executionPolicies?: CrewExecutionPolicies
	providerConfig?: CrewProviderConfig
}

/**
 * Builds the default Web Development crew (Laravel + Inertia + React + shadcn)
 */
export function buildDefaultWebDevCrew(): Crew {
	const now = Date.now()
	return {
		id: "default-web-dev",
		name: "Web Dev (Laravel + Inertia + React/Shadcn)",
		description:
			"Default multi-agent crew for full-stack web development using Laravel backend with Inertia and React (shadcn/ui).",
		architecture: "planner-workers-reviewer",
		default: true,
		tags: ["web", "laravel", "react", "ui"],
		createdTs: now,
		updatedTs: now,
		agents: [
			{
				id: "planner",
				name: "Planner",
				role: "Break down high-level feature requests into backend, frontend, database, and integration tasks; define sequencing.",
				defaultMcpServers: "all",
				enabled: true,
			},
			{
				id: "backend-worker",
				name: "Backend Worker",
				role: "Implement Laravel controllers, models, migrations, validation, service classes, and integration with auth & queues.",
				defaultMcpServers: ["filesystem", "git"],
				enabled: true,
				parallelGroup: "workers",
			},
			{
				id: "frontend-worker",
				name: "Frontend Worker",
				role: "Implement React components (shadcn/ui), Inertia pages, client-side state, forms, and accessibility improvements.",
				defaultMcpServers: ["filesystem"],
				enabled: true,
				parallelGroup: "workers",
			},
			{
				id: "db-schema",
				name: "DB Schema Designer",
				role: "Design & evolve database migrations, indexes, relations, ensuring consistency and performance.",
				defaultMcpServers: ["filesystem"],
				enabled: true,
				parallelGroup: "workers",
			},
			{
				id: "reviewer",
				name: "Reviewer / Refactorer",
				role: "Perform code review, ensure coherence between backend & frontend contracts, suggest refactors & improvements.",
				defaultMcpServers: "all",
				enabled: true,
				reflectionRole: true,
			},
			{
				id: "memory-curator",
				name: "Memory Curator",
				role: "Extract durable architectural decisions, API contracts, schema changes into structured memory entries.",
				defaultMcpServers: ["filesystem"],
				enabled: true,
				reflectionRole: true,
			},
		],
		executionPolicies: {
			termination: {
				maxAgentLoops: 12,
				maxReflectionCycles: 3,
				requireReviewerApproval: true,
			},
			approvals: {
				requirePlanApproval: true,
				requireReflectionGate: true,
			},
			parallel: {
				maxConcurrentAgents: 2,
			},
		},
	}
}
