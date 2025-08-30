import { Empty } from "@shared/proto/cline/common"
import { CustomModelProvider, RemoveCustomModelProviderRequest } from "@shared/proto/cline/crew"
import { Controller } from ".."

/**
 * Removes a custom model provider by id.
 * Semantics:
 *  - If provider does not exist, operation is a no-op (idempotent).
 *  - Returns Empty on success.
 */
export async function removeCustomModelProvider(controller: Controller, request: RemoveCustomModelProviderRequest) {
	const rawId = request.id?.trim()
	if (!rawId) {
		throw new Error("Provider id is required")
	}

	const providers =
		(controller.stateManager.getGlobalStateKey("customModelProviders") as CustomModelProvider[] | undefined) || []

	const next = providers.filter((p) => p.id !== rawId)

	if (next.length !== providers.length) {
		controller.stateManager.setGlobalState("customModelProviders", next)
		await controller.postStateToWebview()
	}

	return Empty.create({})
}

/**
 * TODO (future enhancements):
 *  - Prevent removal while active sessions reference provider
 *  - Audit / checkpoint tagging
 */
