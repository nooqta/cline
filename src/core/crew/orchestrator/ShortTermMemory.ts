/**
 * ShortTermMemory (Phase 1)
 *
 * Ephemeral per-run memory buffer capturing agent thoughts and tool observations.
 * Goals:
 *  - Provide structured, queryable context for planner / reflection phases.
 *  - Allow future filtering (importance, types) without changing orchestrator code.
 *
 * This is intentionally lightweight and in-memory only; persistence / long-term
 * storage will be introduced in later phases.
 */

export type MemoryEntryType = "thought" | "observation"

export interface MemoryEntryBase {
	id: string
	ts: number
	type: MemoryEntryType
}

export interface ThoughtEntry extends MemoryEntryBase {
	type: "thought"
	content: string
	agentId?: string
	phase?: string
}

export interface ObservationEntry extends MemoryEntryBase {
	type: "observation"
	content: string // Summarized observation string (compact for LLM context)
	agentId?: string
	toolId?: string
	success?: boolean
	dataSnippet?: string // Optional truncated data string
	errorType?: string
}

export type MemoryEntry = ThoughtEntry | ObservationEntry

export interface MemorySnapshotOptions {
	lastN?: number
	types?: MemoryEntryType[]
}

export class ShortTermMemory {
	private entries: MemoryEntry[] = []
	private maxEntries: number

	constructor(maxEntries = 200) {
		this.maxEntries = maxEntries
	}

	appendThought(content: string, meta?: { agentId?: string; phase?: string }) {
		this.pushEntry({
			id: this.genId(),
			ts: Date.now(),
			type: "thought",
			content,
			agentId: meta?.agentId,
			phase: meta?.phase,
		})
	}

	appendObservation(params: {
		content: string
		agentId?: string
		toolId?: string
		success?: boolean
		dataSnippet?: string
		errorType?: string
	}) {
		this.pushEntry({
			id: this.genId(),
			ts: Date.now(),
			type: "observation",
			content: params.content,
			agentId: params.agentId,
			toolId: params.toolId,
			success: params.success,
			dataSnippet: params.dataSnippet,
			errorType: params.errorType,
		})
	}

	snapshot(opts: MemorySnapshotOptions = {}): MemoryEntry[] {
		let filtered = this.entries
		if (opts.types && opts.types.length) {
			const set = new Set(opts.types)
			filtered = filtered.filter((e) => set.has(e.type))
		}
		if (opts.lastN && opts.lastN > 0 && filtered.length > opts.lastN) {
			return filtered.slice(filtered.length - opts.lastN)
		}
		return filtered.slice()
	}

	size(): number {
		return this.entries.length
	}

	clear() {
		this.entries = []
	}

	private pushEntry(entry: MemoryEntry) {
		this.entries.push(entry)
		if (this.entries.length > this.maxEntries) {
			// Drop oldest (simple ring buffer behavior)
			this.entries.splice(0, this.entries.length - this.maxEntries)
		}
	}

	private genId(): string {
		// Lightweight unique-ish id (not cryptographic); can swap for ulid later
		return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
	}
}
