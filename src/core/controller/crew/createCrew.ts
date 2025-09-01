import { CreateCrewRequest, Crew as ProtoCrew } from "@shared/proto/cline/crew"
import { Crew as UiCrew, CrewAgent as UiCrewAgent } from "@/shared/Crew"
import { Controller } from ".."
import { crewProtoConverters } from "./listCrews"

/**
 * Generate a URL/slug friendly id from a name
 */
function slugify(base: string): string {
	return (
		base
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.substring(0, 64) || "crew"
	)
}

/**
 * Ensure uniqueness of an id within an existing set by appending a numeric suffix if needed
 */
function ensureUniqueId(desired: string, existingIds: Set<string>): string {
	if (!existingIds.has(desired)) return desired
	let i = 2
	while (existingIds.has(`${desired}-${i}`)) i++
	return `${desired}-${i}`
}

/**
 * Normalize / sanitize agents list from proto into internal UI representation
 */
function normalizeAgents(rawAgents: CreateCrewRequest["agents"]): UiCrewAgent[] {
	const existingIds = new Set<string>()
	return (rawAgents || []).map((a, index) => {
		// Derive id if missing
		let id = a.id?.trim() || slugify(a.name || `agent-${index + 1}`)
		if (existingIds.has(id)) {
			id = ensureUniqueId(id, existingIds)
		}
		existingIds.add(id)

		const defaultMcpServers: UiCrewAgent["defaultMcpServers"] = a.defaultMcpServersAll ? "all" : a.defaultMcpServers || []

		return {
			id,
			name: a.name || id,
			role: a.role || "",
			description: a.description || undefined,
			defaultMcpServers,
			modelProvider: a.modelProvider || undefined,
			modelId: a.modelId || undefined,
			enabled: a.enabled ?? true,
			allowedToolIds: a.allowedToolIds?.length ? [...a.allowedToolIds] : undefined,
			parallelGroup: a.parallelGroup || undefined,
			reflectionRole: a.reflectionRole || undefined,
		}
	})
}

/**
 * Convert execution policies from proto (already camelCased by ts generator) into UI structure
 */
function convertExecutionPolicies(p: CreateCrewRequest["executionPolicies"]): UiCrew["executionPolicies"] | undefined {
	if (!p) return undefined
	return {
		termination: p.termination
			? {
					maxAgentLoops: p.termination.maxAgentLoops || undefined,
					maxReflectionCycles: p.termination.maxReflectionCycles || undefined,
					confidenceKey: p.termination.confidenceKey || undefined,
					requireReviewerApproval: p.termination.requireReviewerApproval || undefined,
				}
			: undefined,
		approvals: p.approvals
			? {
					requirePlanApproval: p.approvals.requirePlanApproval || undefined,
					requireReflectionGate: p.approvals.requireReflectionGate || undefined,
				}
			: undefined,
		parallel: p.parallel
			? {
					maxConcurrentAgents: p.parallel.maxConcurrentAgents || undefined,
				}
			: undefined,
	}
}

/**
 * Creates a new crew (id may be client-suggested; backend will ensure uniqueness)
 */
export async function createCrew(controller: Controller, request: CreateCrewRequest): Promise<ProtoCrew> {
	const now = Date.now()

	// Basic validation
	if (!request.name?.trim()) {
		throw new Error("Crew name is required")
	}
	if (!request.architecture?.trim()) {
		throw new Error("Crew architecture is required")
	}

	// Fetch existing state
	const crews = (controller.stateManager.getGlobalStateKey("crews") as UiCrew[] | undefined) || []
	const existingIds = new Set(crews.map((c) => c.id))

	// Determine (or generate) unique crew id
	const baseId = request.id?.trim() || slugify(request.name)
	const crewId = ensureUniqueId(baseId, existingIds)

	// Normalize agents
	const agents = normalizeAgents(request.agents)

	const newCrew: UiCrew = {
		id: crewId,
		name: request.name.trim(),
		description: request.description || undefined,
		architecture: request.architecture.trim(),
		agents,
		default: false,
		tags: request.tags?.length ? [...request.tags] : [],
		createdTs: now,
		updatedTs: now,
		executionPolicies: convertExecutionPolicies(request.executionPolicies),
		providerConfig: request.providerConfig
			? {
					provider: request.providerConfig.provider || undefined,
					modelId: request.providerConfig.modelId || undefined,
					mcpServerIds: request.providerConfig.mcpServerIds?.length
						? [...request.providerConfig.mcpServerIds]
						: undefined,
					extra: request.providerConfig.extra ? { ...request.providerConfig.extra } : undefined,
				}
			: undefined,
	}

	const updatedCrews = [...crews, newCrew]

	// Persist crews
	controller.stateManager.setGlobalState("crews", updatedCrews)

	// Optionally update selected crew
	if (request.setSelected) {
		controller.stateManager.setGlobalState("selectedCrewId", crewId)
	}

	// Post updated state to webview
	await controller.postStateToWebview()

	return crewProtoConverters.toProtoCrew(newCrew)
}

/**
 * TODO (future enhancements):
 * - Enforce maximum number of crews (soft limit)
 * - Validate agent roles / required reviewer presence if certain policies enabled
 * - Automatically inject reflection / reviewer agent if approvals/termination require it
 * - Audit logging / checkpoint tagging on creation
 */
