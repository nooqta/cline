/**
 * Checkpoint Tagging Helper (Phase 2 Stub)
 *
 * Goal:
 *  - Allow orchestrator to associate lightweight metadata (agentId, phase, optional label)
 *    with checkpoints created inside agent work execution.
 *  - Provide a wrapper that executes arbitrary async work and then triggers a tagged checkpoint.
 *
 * Current Limitations:
 *  - Core checkpoint system (CheckpointTracker) does not yet support structured metadata beyond commit message.
 *  - We therefore serialize metadata into the commit message prefix (future: dedicated metadata store).
 *
 * Future Enhancements:
 *  - Extend CheckpointTracker to accept structured metadata object.
 *  - Add indexing / query utilities (e.g. fetch all checkpoints for agentId=X, phase=reflection).
 *  - Correlate with reflection signals & plan step IDs.
 */

export interface CheckpointTagMeta {
	agentId: string
	phase: "planning" | "execution" | "reflection"
	label?: string
	// Future fields: planStepId, attempt, retryReason, decisionType, etc.
}

export interface CheckpointTrackerLike {
	commit(messagePrefix?: string): Promise<string | undefined>
}

/**
 * Formats a concise commit message prefix embedding metadata.
 * Example: [crew][agent=frontend-worker][phase=execution][label=step-3]
 */
export function formatCheckpointPrefix(meta: CheckpointTagMeta): string {
	const parts = ["[crew]"]
	parts.push(`[agent=${meta.agentId}]`)
	parts.push(`[phase=${meta.phase}]`)
	if (meta.label) parts.push(`[label=${sanitize(meta.label)}]`)
	return parts.join("")
}

function sanitize(v: string): string {
	return v.replace(/\s+/g, "-").slice(0, 64)
}

/**
 * Wrap a work function, then (best-effort) create a tagged checkpoint.
 * If committing fails, the error is swallowed (does not break agent execution),
 * but could later be logged / surfaced via telemetry.
 */
export async function withCheckpointTag<T>(
	tracker: CheckpointTrackerLike | undefined,
	meta: CheckpointTagMeta,
	fn: () => Promise<T>,
): Promise<T> {
	const result = await fn()
	if (tracker) {
		try {
			await tracker.commit(formatCheckpointPrefix(meta))
		} catch {
			/* TODO: optional debug logging / telemetry hook */
		}
	}
	return result
}

/**
 * Factory returning a phase-scoped wrapper usable by ParallelExecutor:
 *
 * const tagWrapper = createCheckpointTagWrapper(tracker)
 * executor = new ParallelExecutor({ withCheckpointTag: tagWrapper, ... })
 */
export function createCheckpointTagWrapper(tracker: CheckpointTrackerLike | undefined) {
	return async function wrapper<T>(agentId: string, phase: string, fn: () => Promise<T>): Promise<T> {
		// Defensive narrowing of phase
		const p = phase === "planning" || phase === "reflection" ? phase : "execution"
		return withCheckpointTag(tracker, { agentId, phase: p }, fn)
	}
}

/**
 * TODO (future):
 *  - Accept richer metadata (JSON) and persist separate from commit message.
 *  - Provide diff introspection utilities grouped by agentId/phase.
 *  - Integrate with reflection cycle to tag remediation attempts.
 *  - Expose metadata to UI for timeline visualization.
 */
