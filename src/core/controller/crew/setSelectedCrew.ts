import { CrewSelectionState, SetSelectedCrewRequest } from "@shared/proto/cline/crew"
import { Crew as UiCrew } from "@/shared/Crew"
import { Controller } from ".."

/**
 * Sets the selected (active) crew id
 * Validates existence. No-op if already selected.
 */
export async function setSelectedCrew(controller: Controller, request: SetSelectedCrewRequest): Promise<CrewSelectionState> {
	const targetId = request.id?.trim()
	if (!targetId) {
		throw new Error("Crew id is required")
	}

	const crews = (controller.stateManager.getGlobalStateKey("crews") as UiCrew[] | undefined) || []
	if (!crews.some((c) => c.id === targetId)) {
		throw new Error(`Crew not found: ${targetId}`)
	}

	const currentSelected = controller.stateManager.getGlobalStateKey("selectedCrewId") as string | undefined
	if (currentSelected !== targetId) {
		controller.stateManager.setGlobalState("selectedCrewId", targetId)
		await controller.postStateToWebview()
	}

	const agentExecutionMode = (controller.stateManager.getGlobalStateKey("agentExecutionMode") as string | undefined) || "single"

	return CrewSelectionState.create({
		selectedCrewId: targetId,
		agentExecutionMode,
	})
}

/**
 * TODO (future enhancements):
 * - Emit event / checkpoint tagging for selection changes
 * - Validate not selecting disabled crew (future flag)
 */
