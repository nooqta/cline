import { Empty } from "@shared/proto/cline/common"
import { DeleteCrewRequest } from "@shared/proto/cline/crew"
import { Crew as UiCrew } from "@/shared/Crew"
import { Controller } from ".."

/**
 * Deletes a crew by id.
 * Invariants:
 * - Cannot delete if crew does not exist
 * - Cannot delete the last remaining crew
 * - If deleting currently selected crew, reassign selection to first remaining
 */
export async function deleteCrew(controller: Controller, request: DeleteCrewRequest) {
	const targetId = request.id?.trim()
	if (!targetId) {
		throw new Error("Crew id is required")
	}

	const crews = (controller.stateManager.getGlobalStateKey("crews") as UiCrew[] | undefined) || []
	if (crews.length === 0) {
		throw new Error("No crews to delete")
	}

	const idx = crews.findIndex((c) => c.id === targetId)
	if (idx === -1) {
		throw new Error(`Crew not found: ${targetId}`)
	}

	if (crews.length === 1) {
		throw new Error("Cannot delete the last remaining crew")
	}

	const selectedCrewId = controller.stateManager.getGlobalStateKey("selectedCrewId") as string | undefined

	const updatedCrews = [...crews.slice(0, idx), ...crews.slice(idx + 1)]

	controller.stateManager.setGlobalState("crews", updatedCrews)

	if (selectedCrewId === targetId) {
		// Reassign selection deterministically to first crew in list
		controller.stateManager.setGlobalState("selectedCrewId", updatedCrews[0].id)
	}

	await controller.postStateToWebview()

	return Empty.create({})
}

/**
 * TODO (future enhancements):
 * - Audit log / checkpoint tagging for deletion events
 * - Prevent deletion if crew is referenced by active tasks (future runtime)
 */
