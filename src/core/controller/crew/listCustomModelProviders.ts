import { CustomModelProvider, ListCustomModelProvidersResponse } from "@shared/proto/cline/crew"
import { Controller } from ".."

/**
 * Lists all registered custom model providers
 */
export async function listCustomModelProviders(controller: Controller): Promise<ListCustomModelProvidersResponse> {
	const providers =
		(controller.stateManager.getGlobalStateKey("customModelProviders") as CustomModelProvider[] | undefined) || []

	return ListCustomModelProvidersResponse.create({
		providers: providers.map((p) =>
			CustomModelProvider.create({
				id: p.id,
				baseUrl: p.baseUrl,
				headers: { ...p.headers },
				models: [...(p.models || [])],
			}),
		),
	})
}

/**
 * TODO (future enhancements):
 *  - Support filtering (by id prefix, model presence)
 *  - Mask sensitive header values on request (optional server-side policy)
 */
