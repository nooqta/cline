import { CustomModelProvider, RegisterCustomModelProviderRequest } from "@shared/proto/cline/crew"
import { Controller } from ".."

/**
 * Simple slug normalization for provider ids (lowercase, alnum + dash)
 */
function normalizeId(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.substring(0, 64)
}

/**
 * Registers (adds or replaces) a custom OpenAI-compatible model provider.
 * Semantics:
 *  - If a provider with the same id exists it is fully replaced.
 *  - Headers map is stored as-is (caller responsible for sensitive value handling).
 *  - Models list may be empty (user can populate later).
 */
export async function registerCustomModelProvider(
	controller: Controller,
	request: RegisterCustomModelProviderRequest,
): Promise<CustomModelProvider> {
	if (!request.provider) {
		throw new Error("Provider payload is required")
	}
	const { id, baseUrl, headers, models } = request.provider
	if (!id?.trim()) {
		throw new Error("Provider id is required")
	}
	if (!baseUrl?.trim()) {
		throw new Error("Provider base_url is required")
	}

	const normId = normalizeId(id)

	const existing =
		(controller.stateManager.getGlobalStateKey("customModelProviders") as CustomModelProvider[] | undefined) || []

	const filtered = existing.filter((p) => p.id !== normId)

	const normalizedProvider: CustomModelProvider = CustomModelProvider.create({
		id: normId,
		baseUrl: baseUrl.trim(),
		headers: headers || {},
		models: models ? [...models] : [],
	})

	const updated = [...filtered, normalizedProvider]
	controller.stateManager.setGlobalState("customModelProviders", updated)
	await controller.postStateToWebview()

	return normalizedProvider
}

/**
 * TODO (future enhancements):
 *  - Validate baseUrl format (URL constructor)
 *  - Prevent duplicate model ids across providers (optional)
 *  - Support incremental model discovery (auto-populate models)
 *  - Secure handling / masking of sensitive headers when surfaced in UI
 */
