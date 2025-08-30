import { Crew as ProtoCrew, UpdateCrewRequest } from "@shared/proto/cline/crew"
import { Crew as UiCrew, CrewAgent as UiCrewAgent } from "@/shared/Crew"
import { Controller } from ".."
import { crewProtoConverters } from "./listCrews"

/**
 * Generate a slug (shared with createCrew; duplicate kept lightweight to avoid cross-file import churn)
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
 * Normalize / sanitize agents list from proto into internal UI representation
 * (Full replacement semantics: caller must send complete agents set even if only one changed)
 */
function normalizeAgents(rawAgents: UpdateCrewRequest["agents"]): UiCrewAgent[] {
	const existingIds = new Set<string>()
	return (rawAgents || []).map((a, index) => {
		// Derive id if missing (should normally be present for updates)
		let id = a.id?.trim() || slugify(a.name || `agent-${index + 1}`)
		if (existingIds.has(id)) {
			// On collision append suffix
			let i = 2
			while (existingIds.has(`${id}-${i}`)) i++
			id = `${id}-${i}`
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
 * Convert execution policies from proto into UI structure
 */
function convertExecutionPolicies(p: UpdateCrewRequest["executionPolicies"]): UiCrew["executionPolicies"] | undefined {
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
 * Updates an existing crew (full replacement of mutable fields)
 */
export async function updateCrew(controller: Controller, request: UpdateCrewRequest): Promise<ProtoCrew> {
	if (!request.id?.trim()) {
		throw new Error("Crew id is required")
	}

	const crews = (controller.stateManager.getGlobalStateKey("crews") as UiCrew[] | undefined) || []
	const idx = crews.findIndex((c) => c.id === request.id)
	if (idx === -1) {
		throw new Error(`Crew not found: ${request.id}`)
	}

	const existing = crews[idx]

	// Prepare updated crew (immutably)
	const updated: UiCrew = {
		...existing,
		// Only replace scalar fields if provided (proto optional)
		name: request.name?.trim() || existing.name,
		description: request.description !== undefined ? request.description : existing.description,
		architecture: request.architecture?.trim() || existing.architecture,
		// Repeated fields: full replacement semantics (client must send full set)
		agents: normalizeAgents(request.agents),
		tags: request.tags ? [...request.tags] : [],
		executionPolicies: convertExecutionPolicies(request.executionPolicies),
		updatedTs: Date.now(),
		// createdTs preserved
	}

	const newCrews = [...crews]
	newCrews[idx] = updated
	controller.stateManager.setGlobalState("crews", newCrews)

	if (request.setSelected) {
		controller.stateManager.setGlobalState("selectedCrewId", updated.id)
	}

	await controller.postStateToWebview()

	return crewProtoConverters.toProtoCrew(updated)
}

/**
 * TODO (future enhancements):
 * - Validation: ensure at least one enabled agent
 * - Warn if reflection/approval policies set but no reflectionRole agents
 * - Enforce soft limits on agent count
 * - Differential update optimization (avoid rewriting unchanged agents)
 * - Checkpoint tagging / audit log
 */
