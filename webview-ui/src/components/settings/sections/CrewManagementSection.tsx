import { EmptyRequest } from "@shared/proto/cline/common"
import {
	Crew,
	CrewAgent,
	CrewProviderConfig,
	ListCrewsResponse,
	SetAgentExecutionModeRequest,
	SetCrewAgentConfigRequest,
	SetCrewProviderConfigRequest,
	SetSelectedCrewRequest,
} from "@shared/proto/cline/crew"
import { VSCodeButton, VSCodeCheckbox, VSCodeRadio, VSCodeRadioGroup, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { CrewServiceClient } from "@/services/grpc-client"
import Section from "../Section"

/**
 * Helper to parse extra provider config key=value lines into a map
 */
function parseExtraConfig(text: string): Record<string, string> | undefined {
	const trimmed = text.trim()
	if (!trimmed) return undefined
	const result: Record<string, string> = {}
	for (const line of trimmed.split(/\r?\n/)) {
		const l = line.trim()
		if (!l) continue
		const eqIdx = l.indexOf("=")
		if (eqIdx === -1) {
			// treat whole line as a flag with value "true"
			result[l] = "true"
		} else {
			const k = l.slice(0, eqIdx).trim()
			const v = l.slice(eqIdx + 1).trim()
			if (k) result[k] = v
		}
	}
	return Object.keys(result).length ? result : undefined
}

/**
 * Stringify extra config map to key=value newline format
 */
function stringifyExtraConfig(extra?: Record<string, string>): string {
	if (!extra) return ""
	return Object.entries(extra)
		.map(([k, v]) => `${k}=${v}`)
		.join("\n")
}

interface CrewManagementSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

/**
 * Crew Management UI:
 * - Fetch & display crews
 * - Show / change selected crew
 * - Toggle agent execution mode (single | crew)
 * - Provider config overrides form (provider/model/mcp servers/extra)
 * - Per-agent override editor (enabled/modelProvider/modelId/allowedToolIds)
 */
const CrewManagementSection = ({ renderSectionHeader }: CrewManagementSectionProps) => {
	const [crews, setCrews] = useState<Crew[]>([])
	const [selectedCrewId, setSelectedCrewId] = useState<string | undefined>()
	const [agentExecutionMode, setAgentExecutionMode] = useState<string>("single")
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | undefined>()

	// Provider config editing state
	const [providerOverrideProvider, setProviderOverrideProvider] = useState("")
	const [providerOverrideModelId, setProviderOverrideModelId] = useState("")
	const [providerOverrideMcpServerIds, setProviderOverrideMcpServerIds] = useState<string[]>([])
	const [providerOverrideExtra, setProviderOverrideExtra] = useState("")
	const [providerSaving, setProviderSaving] = useState(false)
	const [providerDirty, setProviderDirty] = useState(false)

	// Per-agent editing state (map agentId -> draft fields)
	interface AgentDraft {
		enabled?: boolean
		modelProvider?: string
		modelId?: string
		allowedToolIds?: string[]
		saving?: boolean
		dirty?: boolean
	}
	const [agentDrafts, setAgentDrafts] = useState<Record<string, AgentDraft>>({})

	const selectedCrew: Crew | undefined = useMemo(() => crews.find((c) => c.id === selectedCrewId), [crews, selectedCrewId])

	// Suggestions universe for tool IDs (union of existing agent overrides + drafts)
	const toolSuggestions = useMemo(() => {
		const set = new Set<string>()
		selectedCrew?.agents.forEach((a) => a.allowedToolIds?.forEach((id) => set.add(id)))
		Object.values(agentDrafts).forEach((d) => d.allowedToolIds?.forEach((id) => set.add(id)))
		return Array.from(set).sort()
	}, [selectedCrew, agentDrafts])

	const syncProviderFormFromCrew = useCallback((crew?: Crew) => {
		if (!crew || !crew.providerConfig) {
			setProviderOverrideProvider("")
			setProviderOverrideModelId("")
			setProviderOverrideMcpServerIds([])
			setProviderOverrideExtra("")
			setProviderDirty(false)
			return
		}
		const pc = crew.providerConfig
		setProviderOverrideProvider(pc.provider || "")
		setProviderOverrideModelId(pc.modelId || "")
		setProviderOverrideMcpServerIds(pc.mcpServerIds ? [...pc.mcpServerIds] : [])
		setProviderOverrideExtra(stringifyExtraConfig(pc.extra))
		setProviderDirty(false)
	}, [])

	const syncAgentDraftsFromCrew = useCallback((crew?: Crew) => {
		if (!crew) {
			setAgentDrafts({})
			return
		}
		const drafts: Record<string, AgentDraft> = {}
		for (const a of crew.agents) {
			drafts[a.id] = {
				enabled: a.enabled === undefined ? true : a.enabled,
				modelProvider: a.modelProvider || "",
				modelId: a.modelId || "",
				allowedToolIds: a.allowedToolIds ? [...a.allowedToolIds] : [],
				dirty: false,
				saving: false,
			}
		}
		setAgentDrafts(drafts)
	}, [])

	const loadCrews = useCallback(async () => {
		setLoading(true)
		setError(undefined)
		try {
			const resp: ListCrewsResponse = await CrewServiceClient.listCrews(EmptyRequest.create({}))
			const list = resp.crews || []
			setCrews(list)
			const sel = (resp as any).selectedCrewId || (resp as any).selected_crew_id || undefined
			setSelectedCrewId(sel)
			setAgentExecutionMode((resp as any).agentExecutionMode || (resp as any).agent_execution_mode || "single")
			const found = list.find((c) => c.id === sel)
			syncProviderFormFromCrew(found)
			syncAgentDraftsFromCrew(found)
		} catch (e: any) {
			console.error("Failed to load crews:", e)
			setError("Failed to load crews")
		} finally {
			setLoading(false)
		}
	}, [syncProviderFormFromCrew, syncAgentDraftsFromCrew])

	useEffect(() => {
		loadCrews()
	}, [loadCrews])

	const handleSelectCrew = async (id: string) => {
		try {
			await CrewServiceClient.setSelectedCrew(SetSelectedCrewRequest.create({ id }))
			setSelectedCrewId(id)
			const crew = crews.find((c) => c.id === id)
			syncProviderFormFromCrew(crew)
			syncAgentDraftsFromCrew(crew)
		} catch (e) {
			console.error("Failed to select crew:", e)
		}
	}

	const handleExecutionModeChange = async (mode: string) => {
		try {
			setAgentExecutionMode(mode)
			await CrewServiceClient.setAgentExecutionMode(SetAgentExecutionModeRequest.create({ mode }))
		} catch (e) {
			console.error("Failed to set execution mode:", e)
		}
	}

	// Provider Config Save
	const handleSaveProviderConfig = async () => {
		if (!selectedCrewId) return
		setProviderSaving(true)
		try {
			// Build config (empty fields omitted => cleared)
			const extraParsed = parseExtraConfig(providerOverrideExtra)
			const mcpIds = providerOverrideMcpServerIds.filter((s) => s && s.trim().length > 0)
			const config: any = {
				provider: providerOverrideProvider.trim() || undefined,
				modelId: providerOverrideModelId.trim() || undefined,
			}
			if (mcpIds.length > 0) {
				config.mcpServerIds = mcpIds
			}
			if (extraParsed) {
				config.extra = extraParsed
			}
			// (mcpServerIds already normalized above)
			await CrewServiceClient.setCrewProviderConfig(
				SetCrewProviderConfigRequest.create({
					crewId: selectedCrewId,
					config: config as any, // proto expects object shape
				}),
			)
			// Reload to reflect updated timestamps & conversions
			await loadCrews()
			setProviderDirty(false)
		} catch (e) {
			console.error("Failed to save provider config:", e)
		} finally {
			setProviderSaving(false)
		}
	}

	const handleResetProviderConfig = () => {
		syncProviderFormFromCrew(selectedCrew)
	}

	// Agent draft change helpers
	const updateAgentDraft = (agentId: string, patch: Partial<AgentDraft>) => {
		setAgentDrafts((prev) => ({
			...prev,
			[agentId]: {
				...prev[agentId],
				...patch,
				dirty: true,
			},
		}))
	}

	const handleSaveAgent = async (agent: CrewAgent, draft: AgentDraft) => {
		if (!selectedCrewId) return
		setAgentDrafts((prev) => ({
			...prev,
			[agent.id]: { ...draft, saving: true },
		}))
		try {
			const allowedToolIds = draft.allowedToolIds || []
			await CrewServiceClient.setCrewAgentConfig(
				SetCrewAgentConfigRequest.create({
					crewId: selectedCrewId,
					agentId: agent.id,
					enabled: draft.enabled,
					modelProvider: draft.modelProvider?.trim() || undefined,
					modelId: draft.modelId?.trim() || undefined,
					allowedToolIds,
				}) as any,
			)
			await loadCrews()
		} catch (e) {
			console.error("Failed to save agent config:", e)
			// leave dirty so user can retry
		} finally {
			setAgentDrafts((prev) => ({
				...prev,
				[agent.id]: { ...prev[agent.id], saving: false, dirty: false },
			}))
		}
	}

	return (
		<div>
			{renderSectionHeader("crews")}
			<Section>
				<div className="flex flex-col gap-5">
					{/* Execution Mode */}
					<div>
						<h5 className="m-0 mb-2">Agent Execution Mode</h5>
						<VSCodeRadioGroup
							onChange={(e: any) => handleExecutionModeChange(e.target.value)}
							orientation="horizontal"
							value={agentExecutionMode}>
							<VSCodeRadio value="single">Single</VSCodeRadio>
							<VSCodeRadio value="crew">Crew</VSCodeRadio>
						</VSCodeRadioGroup>
						<p className="text-xs mt-2 text-[var(--vscode-descriptionForeground)]">
							Single mode runs with one active model; Crew mode orchestrates multiple specialized agents.
						</p>
					</div>

					{/* Crew List */}
					<div className="flex items-center justify-between">
						<h5 className="m-0">Crews</h5>
						<div className="flex gap-2">
							<VSCodeButton appearance="secondary" disabled>
								Create Crew (soon)
							</VSCodeButton>
							<VSCodeButton appearance="secondary" disabled={loading} onClick={loadCrews}>
								{loading ? "Refreshing..." : "Refresh"}
							</VSCodeButton>
						</div>
					</div>

					{error && <div className="text-[var(--vscode-errorForeground)] text-sm">{error}</div>}

					<div className="flex flex-col gap-2">
						{loading && crews.length === 0 && <div className="text-sm opacity-70">Loading crews...</div>}
						{!loading && crews.length === 0 && <div className="text-sm opacity-70">No crews found.</div>}
						{crews.map((crew) => {
							const isSelected = crew.id === selectedCrewId
							return (
								<div
									className={`border rounded p-3 flex flex-col gap-2 ${
										isSelected
											? "border-[var(--vscode-focusBorder)] bg-[var(--vscode-list-activeSelectionBackground)]"
											: "border-[var(--vscode-panel-border)] bg-[var(--vscode-panel-background)]"
									}`}
									key={crew.id}>
									<div className="flex items-center justify-between">
										<div className="flex flex-col">
											<span className="font-medium">{crew.name}</span>
											<span className="text-xs opacity-70">
												{crew.architecture} • {crew.agents.length} agent
												{crew.agents.length !== 1 && "s"}
											</span>
										</div>
										<div className="flex gap-2">
											{!isSelected && (
												<VSCodeButton appearance="secondary" onClick={() => handleSelectCrew(crew.id)}>
													Select
												</VSCodeButton>
											)}
											{isSelected && (
												<VSCodeButton appearance="secondary" disabled>
													Selected
												</VSCodeButton>
											)}
										</div>
									</div>
									{crew.description && <div className="text-xs opacity-80">{crew.description}</div>}
									<div className="text-[10px] opacity-50 flex flex-wrap gap-2">
										{crew.agents.slice(0, 6).map((a) => (
											<span
												className="px-1 py-[1px] rounded bg-[var(--vscode-input-background)]"
												key={a.id}>
												{a.name}
											</span>
										))}
										{crew.agents.length > 6 && (
											<span className="opacity-60">+{crew.agents.length - 6} more</span>
										)}
									</div>
								</div>
							)
						})}
					</div>

					{/* Provider Config Override */}
					{selectedCrew && (
						<div className="mt-4 flex flex-col gap-3 border rounded p-3 bg-[var(--vscode-panel-background)]">
							<div className="flex items-center justify-between">
								<h5 className="m-0">Provider Override (Crew Level)</h5>
								<div className="flex gap-2">
									<VSCodeButton
										appearance="secondary"
										disabled={providerSaving || !providerDirty}
										onClick={handleSaveProviderConfig}>
										{providerSaving ? "Saving..." : "Save"}
									</VSCodeButton>
									<VSCodeButton
										appearance="secondary"
										disabled={providerSaving || !providerDirty}
										onClick={handleResetProviderConfig}>
										Reset
									</VSCodeButton>
								</div>
							</div>
							<div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
								<VSCodeTextField
									onInput={(e: any) => {
										setProviderOverrideProvider(e.target.value)
										setProviderDirty(true)
									}}
									placeholder="Provider (e.g. openai, openrouter)"
									value={providerOverrideProvider}>
									Provider
								</VSCodeTextField>
								<VSCodeTextField
									onInput={(e: any) => {
										setProviderOverrideModelId(e.target.value)
										setProviderDirty(true)
									}}
									placeholder="Model ID"
									value={providerOverrideModelId}>
									Model ID
								</VSCodeTextField>
								{/* MCP Servers multi-select moved below */}
							</div>
							{/* MCP Servers Multi-select */}
							<McpServersMultiSelect
								onChange={(next) => {
									setProviderOverrideMcpServerIds(next)
									setProviderDirty(true)
								}}
								selected={providerOverrideMcpServerIds}
							/>
							<VSCodeTextField
								onInput={(e: any) => {
									setProviderOverrideExtra(e.target.value)
									setProviderDirty(true)
								}}
								placeholder={"temperature=0.4\nmax_output_tokens=4096"}
								style={{ width: "100%", minHeight: "80px" }}
								value={providerOverrideExtra}>
								Extra (key=value per line)
							</VSCodeTextField>
							<p className="text-xs opacity-60 m-0">
								Empty fields clear overrides (inherit global). Extra lines with no '=' become boolean flags set to
								true.
							</p>
						</div>
					)}

					{/* Agents Override Editor */}
					{selectedCrew && (
						<div className="mt-2 flex flex-col gap-3 border rounded p-3 bg-[var(--vscode-panel-background)]">
							<h5 className="m-0">Agents Overrides</h5>
							<div className="flex flex-col gap-3">
								{selectedCrew.agents.map((agent) => {
									const draft = agentDrafts[agent.id] || {}
									return (
										<div
											className="border rounded p-2 flex flex-col gap-2 bg-[var(--vscode-input-background)]"
											key={agent.id}>
											<div className="flex items-center justify-between">
												<div className="flex flex-col">
													<span className="text-sm font-medium">{agent.name}</span>
													<span className="text-[10px] opacity-60">{agent.role}</span>
												</div>
												<div className="flex items-center gap-3">
													<label className="flex items-center gap-1 text-[11px]">
														<VSCodeCheckbox
															checked={draft.enabled}
															onChange={(e: any) =>
																updateAgentDraft(agent.id, { enabled: e.target.checked })
															}
														/>
														Enabled
													</label>
													<VSCodeButton
														appearance="secondary"
														disabled={draft.saving || !draft.dirty}
														onClick={() => handleSaveAgent(agent, draft)}>
														{draft.saving ? "Saving..." : "Save"}
													</VSCodeButton>
												</div>
											</div>
											<div
												className="grid gap-2"
												style={{ gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
												<VSCodeTextField
													onInput={(e: any) =>
														updateAgentDraft(agent.id, { modelProvider: e.target.value })
													}
													placeholder="Override provider"
													value={draft.modelProvider || ""}>
													Provider
												</VSCodeTextField>
												<VSCodeTextField
													onInput={(e: any) => updateAgentDraft(agent.id, { modelId: e.target.value })}
													placeholder="Override model id"
													value={draft.modelId || ""}>
													Model ID
												</VSCodeTextField>
												<AgentAllowedToolsMultiSelect
													onChange={(next) => updateAgentDraft(agent.id, { allowedToolIds: next })}
													selected={draft.allowedToolIds || []}
													suggestions={toolSuggestions}
												/>
											</div>
											{(draft.dirty || draft.saving) && (
												<div className="text-[10px] opacity-60">
													{draft.saving ? "Persisting..." : "Unsaved changes - click Save to apply."}
												</div>
											)}
										</div>
									)
								})}
							</div>
							<p className="text-xs opacity-60 m-0">
								Clearing a field removes the override so the agent inherits crew/global configuration. Empty
								Allowed Tool IDs input clears allowlist (agent can use all permitted tools).
							</p>
						</div>
					)}

					<div className="text-xs opacity-60">
						Future: advanced execution policies, reflection loops, parallel batching controls.
					</div>
				</div>
			</Section>
		</div>
	)
}

/**
 * MCP Servers multi-select component (checkbox list)
 */
const McpServersMultiSelect = ({ selected, onChange }: { selected: string[]; onChange: (next: string[]) => void }) => {
	const { mcpServers } = useExtensionState()
	const toggle = (id: string) => {
		if (selected.includes(id)) {
			onChange(selected.filter((x) => x !== id))
		} else {
			onChange([...selected, id])
		}
	}
	const allSelected = selected.length > 0 && mcpServers.length > 0 && selected.length === mcpServers.length
	const handleSelectAll = () => {
		if (allSelected) {
			onChange([])
		} else {
			onChange(mcpServers.map((s) => s.name))
		}
	}
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between">
				<span className="text-xs opacity-70">MCP Servers (leave all unchecked to inherit all)</span>
				{mcpServers.length > 0 && (
					<VSCodeButton
						appearance="secondary"
						onClick={handleSelectAll}
						style={{ padding: "2px 6px", fontSize: "10px" }}>
						{allSelected ? "Clear All" : "Select All"}
					</VSCodeButton>
				)}
			</div>
			<div className="flex flex-wrap gap-2">
				{mcpServers.length === 0 && <span className="text-[10px] opacity-60">No MCP servers installed</span>}
				{mcpServers.map((s) => {
					const checked = selected.includes(s.name)
					return (
						<label
							key={s.name}
							style={{
								display: "flex",
								alignItems: "center",
								gap: 4,
								border: "1px solid var(--vscode-panel-border)",
								borderRadius: 4,
								padding: "2px 6px",
								background: checked
									? "var(--vscode-inputOption-activeBackground)"
									: "var(--vscode-input-background)",
								cursor: "pointer",
								fontSize: "11px",
							}}>
							<VSCodeCheckbox checked={checked} onChange={() => toggle(s.name)} style={{ margin: 0 }} />
							<span>{s.name}</span>
						</label>
					)
				})}
			</div>
		</div>
	)
}

/**
 * Agent Allowed Tools multi-select (with add custom)
 * None selected => inherit all tools.
 */
const AgentAllowedToolsMultiSelect = ({
	selected,
	onChange,
	suggestions,
}: {
	selected: string[]
	onChange: (next: string[]) => void
	suggestions: string[]
}) => {
	const [newTool, setNewTool] = useState("")
	const toggle = (id: string) => {
		if (selected.includes(id)) {
			onChange(selected.filter((x) => x !== id))
		} else {
			onChange([...selected, id])
		}
	}
	const addNew = () => {
		const t = newTool.trim()
		if (!t) return
		if (!selected.includes(t)) {
			onChange([...selected, t])
		}
		setNewTool("")
	}
	return (
		<div className="flex flex-col gap-1">
			<span className="text-xs opacity-70">Allowed Tool IDs (none selected = inherit all)</span>
			<div className="flex flex-wrap gap-2">
				{suggestions.length === 0 && selected.length === 0 && (
					<span className="text-[10px] opacity-60">No tool suggestions yet</span>
				)}
				{suggestions.map((s) => {
					const checked = selected.includes(s)
					return (
						<label
							key={s}
							style={{
								display: "flex",
								alignItems: "center",
								gap: 4,
								border: "1px solid var(--vscode-panel-border)",
								borderRadius: 4,
								padding: "2px 6px",
								background: checked
									? "var(--vscode-inputOption-activeBackground)"
									: "var(--vscode-input-background)",
								cursor: "pointer",
								fontSize: "11px",
							}}>
							<VSCodeCheckbox checked={checked} onChange={() => toggle(s)} style={{ margin: 0 }} />
							<span>{s}</span>
						</label>
					)
				})}
			</div>
			<div className="flex items-center gap-2 mt-1">
				<VSCodeTextField
					onInput={(e: any) => setNewTool(e.target.value)}
					onKeyDown={(e: any) => {
						if (e.key === "Enter") {
							e.preventDefault()
							addNew()
						}
					}}
					placeholder="Add tool id"
					style={{ flex: 1 }}
					value={newTool}>
					New Tool
				</VSCodeTextField>
				<VSCodeButton appearance="secondary" disabled={!newTool.trim()} onClick={addNew}>
					Add
				</VSCodeButton>
				{selected.length > 0 && (
					<VSCodeButton appearance="secondary" onClick={() => onChange([])} style={{ whiteSpace: "nowrap" }}>
						Clear
					</VSCodeButton>
				)}
			</div>
		</div>
	)
}

export default CrewManagementSection
