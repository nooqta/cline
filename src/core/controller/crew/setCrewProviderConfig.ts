import { Crew as ProtoCrew, SetCrewProviderConfigRequest } from "@shared/proto/cline/crew"
import { Crew as UiCrew } from "@/shared/Crew"
import { Controller } from ".."
import { crewProtoConverters } from "./listCrews"

/**
 * Sets or clears crew-level provider configuration overrides.
 * Full replacement semantics: any omitted optional fields are cleared.
 */
export async function setCrewProviderConfig(controller: Controller, request: SetCrewProviderConfigRequest): Promise<ProtoCrew> {
	const crewId = request.crewId?.trim()
	if (!crewId) {
		throw new Error("crew_id is required")
	}

	const crews = (controller.stateManager.getGlobalStateKey("crews") as UiCrew[] | undefined) || []
	const idx = crews.findIndex((c) => c.id === crewId)
	if (idx === -1) {
		throw new Error(`Crew not found: ${crewId}`)
	}

	const existing = crews[idx]

	// Normalize replacement config (treat missing object or undefined fields as clearing)
	const cfg = request.config
	const providerConfig = cfg
		? {
				provider: cfg.provider || undefined,
				modelId: cfg.modelId || undefined,
				mcpServerIds: cfg.mcpServerIds?.length ? [...cfg.mcpServerIds] : undefined,
				extra: cfg.extra ? { ...cfg.extra } : undefined,
			}
		: undefined

	const updated: UiCrew = {
		...existing,
		providerConfig,
		updatedTs: Date.now(),
	}

	const newCrews = [...crews]
	newCrews[idx] = updated
	controller.stateManager.setGlobalState("crews", newCrews)
	await controller.postStateToWebview()

	return crewProtoConverters.toProtoCrew(updated)
}

/**
 * TODO (future enhancements):
 * - Validate provider/model against registered providers / global configuration
 * - Enforce allowed MCP server subset exists in global MCP registry
 * - Audit logging / checkpoint tagging of overrides
 * - Diff-based update to avoid unnecessary webview posts (micro-optimization)
 */
