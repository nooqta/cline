import { expect } from "chai"
import { Crew } from "@/shared/Crew"
import { CrewOrchestratorConfig, createCrewOrchestrator } from "../core/crew/orchestrator/CrewOrchestrator"
import { Plan } from "../core/crew/orchestrator/PlanTypes"
import { ShortTermMemory } from "../core/crew/orchestrator/ShortTermMemory"

// Utility: build minimal crew
function buildMinimalCrew(): Crew {
	const now = Date.now()
	return {
		id: "crew1",
		name: "Test Crew",
		architecture: "planner-workers",
		createdTs: now,
		updatedTs: now,
		agents: [
			{
				id: "workerA",
				name: "Worker A",
				role: "General worker",
				defaultMcpServers: [],
				enabled: true,
				parallelGroup: "workers",
			},
			{
				id: "workerB",
				name: "Worker B",
				role: "General worker",
				defaultMcpServers: [],
				enabled: true,
				parallelGroup: "workers",
			},
		],
	}
}

describe("CrewOrchestrator Phase 2 completion tests", () => {
	it("falls back to skeleton plan when planner repeatedly fails", async () => {
		// LLM stub that always returns invalid non-JSON content
		const failingLlm = {
			chat: async () => ({ text: "Not JSON -- attempt" }),
		}

		const crew = buildMinimalCrew()
		const globalState: Record<string, any> = {
			crews: [crew],
			selectedCrewId: crew.id,
		}

		const cfg: CrewOrchestratorConfig = {
			llm: failingLlm,
			getGlobalState: (k) => globalState[k],
			routeDecisionMaxAttempts: 1, // reduce route attempts (we assume route will succeed with default direct JSON here)
			onPlanAttempt: () => {}, // noop
		}

		// Route decision path needs to succeed: provide LLM override for route only by monkey patch:
		// We wrap orchestrator after creation and override acquireRouteDecision? Simpler: create a llm that returns a valid route decision first, then invalid plan.
		// Adjust: create a composite llm with internal call count.
		let callCount = 0
		cfg.llm = {
			chat: async () => {
				callCount++
				if (callCount === 1) {
					// Route decision (valid JSON)
					return {
						text: JSON.stringify({
							strategy: "plan_then_parallel",
							rationale: "Need planning",
						}),
					}
				}
				// Planner invocations -> invalid
				return { text: "garbled planner output" }
			},
		}

		const orchestrator = createCrewOrchestrator(cfg)
		const result = await orchestrator.run({ goal: "Build feature X" })

		expect(result.planGenerated).to.equal(true)
		expect(result.plan?.rationale).to.match(/Skeleton auto-generated plan/)
		// Memory should include fallback observation
		const mem = orchestrator.getShortTermMemory().snapshot()
		const fallbackEntry = mem.find((e) => e.type === "observation" && e.content.includes("Planner failed"))
		expect(fallbackEntry).to.exist
	})

	it("emits telemetry hooks for plan & step lifecycle", async () => {
		// LLM stub that returns route decision then a valid plan with 2 parallel steps
		let call = 0
		const telemetry: {
			planGeneratedVia?: string
			stepEvents: Array<{ id: string; event: string }>
			waves: number[]
		} = { stepEvents: [], waves: [] }

		const llm = {
			chat: async () => {
				call++
				if (call === 1) {
					return {
						text: JSON.stringify({
							strategy: "plan_then_parallel",
							rationale: "Parallel feasible",
						}),
					}
				}
				return {
					text: JSON.stringify({
						rationale: "Two independent steps",
						steps: [
							{ id: "s1", description: "Do first thing", parallelGroup: "workers" },
							{ id: "s2", description: "Do second thing", parallelGroup: "workers" },
						],
					}),
				}
			},
		}

		const crew = buildMinimalCrew()
		const globalState: Record<string, any> = {
			crews: [crew],
			selectedCrewId: crew.id,
		}

		const cfg: CrewOrchestratorConfig = {
			llm,
			getGlobalState: (k) => globalState[k],
			onPlanGenerated: (plan: Plan, via) => {
				telemetry.planGeneratedVia = via
			},
			onPlanStepUpdate: (step, event) => {
				telemetry.stepEvents.push({ id: step.id, event })
			},
			onPlanWaveComplete: (waveIndex) => {
				telemetry.waves.push(waveIndex)
			},
		}

		const orchestrator = createCrewOrchestrator(cfg)
		const result = await orchestrator.run({ goal: "Parallel demo" })

		expect(result.planGenerated).to.equal(true)
		expect(telemetry.planGeneratedVia).to.equal("planner")
		// Expect events: start + success per step (order may vary)
		const starts = telemetry.stepEvents.filter((e) => e.event === "start").length
		const successes = telemetry.stepEvents.filter((e) => e.event === "success").length
		expect(starts).to.equal(2)
		expect(successes).to.equal(2)
		expect(telemetry.waves.length).to.equal(1)
		// Memory should contain rationale & summary
		const mem = orchestrator.getShortTermMemory().snapshot()
		const rationaleEntry = mem.find((e) => e.type === "thought" && e.content.includes("Plan rationale"))
		const summaryEntry = mem.find((e) => e.type === "thought" && e.content.includes("Plan execution summary"))
		expect(rationaleEntry).to.exist
		expect(summaryEntry).to.exist
	})
})
