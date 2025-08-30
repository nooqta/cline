import { EmptyRequest } from "@shared/proto/cline/common"
import { ListCrewsResponse, Crew as ProtoCrew, CrewAgent as ProtoCrewAgent } from "@shared/proto/cline/crew"
import { Crew as UiCrew, CrewAgent as UiCrewAgent } from "@/shared/Crew"
import { Controller } from ".."

/**
 * Convert internal UI agent representation to proto agent
 */
function toProtoAgent(a: UiCrewAgent): ProtoCrewAgent {
	return ProtoCrewAgent.create({
		id: a.id,
		name: a.name,
		role: a.role,
		description: a.description,
		defaultMcpServers: Array.isArray(a.defaultMcpServers) ? a.defaultMcpServers : [],
		defaultMcpServersAll: a.defaultMcpServers === "all",
		modelProvider: a.modelProvider,
		modelId: a.modelId,
		enabled: a.enabled,
		allowedToolIds: a.allowedToolIds || [],
		parallelGroup: a.parallelGroup,
		reflectionRole: a.reflectionRole,
	})
}

/**
 * Convert internal UI crew representation to proto crew
 */
function toProtoCrew(c: UiCrew): ProtoCrew {
	return ProtoCrew.create({
		id: c.id,
		name: c.name,
		description: c.description,
		architecture: c.architecture,
		agents: c.agents.map(toProtoAgent),
		default: c.default,
		tags: c.tags || [],
		createdTs: c.createdTs,
		updatedTs: c.updatedTs,
		executionPolicies: c.executionPolicies
			? {
					termination: c.executionPolicies.termination
						? {
								maxAgentLoops: c.executionPolicies.termination.maxAgentLoops,
								confidenceKey: c.executionPolicies.termination.confidenceKey,
								requireReviewerApproval: c.executionPolicies.termination.requireReviewerApproval,
								maxReflectionCycles: c.executionPolicies.termination.maxReflectionCycles,
							}
						: undefined,
					approvals: c.executionPolicies.approvals
						? {
								requirePlanApproval: c.executionPolicies.approvals.requirePlanApproval,
								requireReflectionGate: c.executionPolicies.approvals.requireReflectionGate,
							}
						: undefined,
					parallel: c.executionPolicies.parallel
						? {
								maxConcurrentAgents: c.executionPolicies.parallel.maxConcurrentAgents,
							}
						: undefined,
				}
			: undefined,
	})
}

/**
 * Returns all stored crews and current selection / mode
 */
export async function listCrews(controller: Controller, _request: EmptyRequest): Promise<ListCrewsResponse> {
	const crews = controller.stateManager.getGlobalStateKey("crews") as UiCrew[] | undefined
	const selectedCrewId = controller.stateManager.getGlobalStateKey("selectedCrewId") as string | undefined
	const agentExecutionMode = controller.stateManager.getGlobalStateKey("agentExecutionMode") as string | undefined

	return ListCrewsResponse.create({
		crews: (crews || []).map(toProtoCrew),
		selectedCrewId,
		agentExecutionMode: agentExecutionMode || "single",
	})
}

// Export converters for reuse in other handler implementations
export const crewProtoConverters = {
	toProtoCrew,
	toProtoAgent,
}
