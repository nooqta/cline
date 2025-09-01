import { expect } from "chai"
import { ParallelExecutor } from "../core/crew/orchestrator/ParallelExecutor"
import { PlanDAGExecutor } from "../core/crew/orchestrator/PlanDAGExecutor"
import { Plan, PlanStep } from "../core/crew/orchestrator/PlanTypes"

describe("PlanDAGExecutor", () => {
	function makeStep(id: string, dependsOn: string[] = [], parallelGroup?: string): PlanStep {
		return {
			id,
			description: `Step ${id}`,
			dependsOn,
			parallelGroup,
			status: "pending",
		}
	}

	it("executes independent steps in one wave", async () => {
		const plan: Plan = {
			id: "p1",
			createdTs: Date.now(),
			steps: [makeStep("s1"), makeStep("s2"), makeStep("s3")],
			rationale: "independent",
		}

		const executor = new ParallelExecutor({ maxConcurrent: 5 })
		const dag = new PlanDAGExecutor({ parallelExecutor: executor })

		const result = await dag.run(plan, (step) => ({
			agentId: step.agentId || step.id,
			phase: "execution",
			input: undefined,
			run: async () => ({
				agentId: step.agentId || step.id,
				phase: "execution",
				success: true,
				output: { done: true },
				startedAt: Date.now(),
				finishedAt: Date.now(),
			}),
		}))

		expect(result.waves).to.equal(1)
		expect(result.stepsExecuted).to.equal(3)
		plan.steps.forEach((s) => expect(s.status).to.equal("done"))
	})

	it("respects dependencies across multiple waves", async () => {
		// s3 depends on s1 & s2, s4 depends on s3 -> should produce at least 3 waves
		const plan: Plan = {
			id: "p2",
			createdTs: Date.now(),
			steps: [makeStep("s1"), makeStep("s2"), makeStep("s3", ["s1", "s2"]), makeStep("s4", ["s3"])],
			rationale: "chain",
		}

		const executor = new ParallelExecutor({ maxConcurrent: 2 })
		const waves: number[] = []
		const dag = new PlanDAGExecutor({
			parallelExecutor: executor,
			hooks: {
				onWaveStart: (waveIndex) => {
					waves.push(waveIndex)
				},
			},
		})

		const result = await dag.run(plan, (step) => ({
			agentId: step.agentId || step.id,
			phase: "execution",
			input: undefined,
			run: async () => ({
				agentId: step.agentId || step.id,
				phase: "execution",
				success: true,
				output: { done: true },
				startedAt: Date.now(),
				finishedAt: Date.now(),
			}),
		}))

		expect(result.stepsExecuted).to.equal(4)
		expect(result.waves).to.be.greaterThanOrEqual(3) // (s1+s2) -> (s3) -> (s4)
		expect(waves[0]).to.equal(0)
		expect(plan.steps.map((s) => s.status)).to.deep.equal(["done", "done", "done", "done"])
	})

	it("marks deadlocked steps as error", async () => {
		// s2 depends on missing step sX -> deadlock scenario
		const plan: Plan = {
			id: "p3",
			createdTs: Date.now(),
			steps: [makeStep("s1"), makeStep("s2", ["sX"])],
			rationale: "deadlock",
		}

		const executor = new ParallelExecutor({ maxConcurrent: 2 })
		const dag = new PlanDAGExecutor({ parallelExecutor: executor })

		const result = await dag.run(plan, (step) => ({
			agentId: step.agentId || step.id,
			phase: "execution",
			input: undefined,
			run: async () => ({
				agentId: step.agentId || step.id,
				phase: "execution",
				success: true,
				output: { done: true },
				startedAt: Date.now(),
				finishedAt: Date.now(),
			}),
		}))

		expect(result.stepsExecuted).to.equal(1) // only s1 ran
		const s1 = plan.steps.find((s) => s.id === "s1")!
		const s2 = plan.steps.find((s) => s.id === "s2")!
		expect(s1.status).to.equal("done")
		expect(s2.status).to.equal("error")
		expect(s2.errorMessage).to.match(/Deadlock/)
	})
})
