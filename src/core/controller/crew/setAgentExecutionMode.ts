import { CrewSelectionState, SetAgentExecutionModeRequest } from "@shared/proto/cline/crew"
import { AgentExecutionMode } from "@/shared/Crew"
import { Controller } from ".."

/**
 * Allowed execution modes (kept local for easy future extension)
 */
const ALLOWED_MODES: AgentExecutionMode[] = ["single", "crew"]

function normalizeMode(raw: string | undefined): AgentExecutionMode {
	const m = raw?.trim().toLowerCase() as AgentExecutionMode | undefined
	if (!m || !ALLOWED_MODES.includes(m)) {
		throw new Error(`Invalid agent execution mode: ${raw}. Allowed: ${ALLOWED_MODES.join(", ")}`)
	}
	return m
}

/**
 * Sets the agent execution mode ("single" | "crew")
 * - Validates mode
 * - Avoids unnecessary state updates if unchanged
 */
export async function setAgentExecutionMode(
	controller: Controller,
	request: SetAgentExecutionModeRequest,
): Promise<CrewSelectionState> {
	const desired = normalizeMode(request.mode)
	const current =
		(controller.stateManager.getGlobalStateKey("agentExecutionMode") as AgentExecutionMode | undefined) || "single"

	if (current !== desired) {
		controller.stateManager.setGlobalState("agentExecutionMode", desired)
		await controller.postStateToWebview()
	}

	const selectedCrewId = (controller.stateManager.getGlobalStateKey("selectedCrewId") as string | undefined) || undefined

	return CrewSelectionState.create({
		selectedCrewId,
		agentExecutionMode: desired,
	})
}

/**
 * TODO (future enhancements):
 * - Trigger orchestrator reset when switching modes
 * - Reject switching while an execution loop is active
 * - Audit / checkpoint tagging
 */
