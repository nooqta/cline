import { CrewAgent as ProtoCrewAgent, SetCrewAgentConfigRequest } from "@shared/proto/cline/crew"
import { Crew as UiCrew, CrewAgent as UiCrewAgent } from "@/shared/Crew"
import { Controller } from ".."
import { crewProtoConverters } from "./listCrews"

/**
 * Updates a single agent's override fields (enabled/model/tool allowlist) within a crew.
 * Only provided optional scalar fields are mutated; others are left unchanged.
 * allowed_tool_ids:
 *   - If the field is present in the request (even if empty) it replaces the existing allowlist.
 *   - If omitted, existing allowlist is preserved.
 */
export async function setCrewAgentConfig(controller: Controller, request: SetCrewAgentConfigRequest): Promise<ProtoCrewAgent> {
	const crewId = request.crewId?.trim()
	if (!crewId) {
		throw new Error("crew_id is required")
	}
	const agentId = request.agentId?.trim()
	if (!agentId) {
		throw new Error("agent_id is required")
	}

	const crews = (controller.stateManager.getGlobalStateKey("crews") as UiCrew[] | undefined) || []
	const crewIdx = crews.findIndex((c) => c.id === crewId)
	if (crewIdx === -1) {
		throw new Error(`Crew not found: ${crewId}`)
	}

	const crew = crews[crewIdx]
	const agentIdx = crew.agents.findIndex((a) => a.id === agentId)
	if (agentIdx === -1) {
		throw new Error(`Agent not found in crew '${crewId}': ${agentId}`)
	}

	const existingAgent = crew.agents[agentIdx]

	// Mutate copy of agent with only provided overrides
	const updatedAgent: UiCrewAgent = {
		...existingAgent,
		enabled: request.enabled !== undefined ? request.enabled : existingAgent.enabled,
		modelProvider: request.modelProvider !== undefined ? request.modelProvider || undefined : existingAgent.modelProvider,
		modelId: request.modelId !== undefined ? request.modelId || undefined : existingAgent.modelId,
		allowedToolIds:
			request.allowedToolIds && request.allowedToolIds.length
				? [...request.allowedToolIds]
				: request.allowedToolIds
					? [] // explicit empty list clears override
					: existingAgent.allowedToolIds,
	}

	if (
		updatedAgent.enabled === existingAgent.enabled &&
		updatedAgent.modelProvider === existingAgent.modelProvider &&
		updatedAgent.modelId === existingAgent.modelId &&
		(updatedAgent.allowedToolIds?.join("|") || "") === (existingAgent.allowedToolIds?.join("|") || "")
	) {
		// No effective change; return current proto without persisting mutably updatedTs
		return crewProtoConverters.toProtoAgent(existingAgent)
	}

	const updatedCrew: UiCrew = {
		...crew,
		agents: crew.agents.map((a, i) => (i === agentIdx ? updatedAgent : a)),
		updatedTs: Date.now(),
	}

	const newCrews = [...crews]
	newCrews[crewIdx] = updatedCrew
	controller.stateManager.setGlobalState("crews", newCrews)
	await controller.postStateToWebview()

	return crewProtoConverters.toProtoAgent(updatedAgent)
}

/**
 * TODO (future enhancements):
 * - Validate modelProvider/modelId against crew-level / global config & custom providers
 * - Ensure disabled agent cannot be required by execution policies (e.g., reflectionRole)
 * - Enforce allowedToolIds subset of resolved tool universe
 * - Audit / checkpoint tagging of agent override changes
 * - Add optimistic concurrency (version check) to prevent lost updates
 */
