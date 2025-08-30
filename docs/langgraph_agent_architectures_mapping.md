# LangGraph Agent Architectures Mapping (Router, Tool-Calling, Custom Patterns) To Cline Multi-Agent (Crew) Plan

Purpose: Paraphrased distillation of the LangGraph “Agent architectures” concepts and how each primitive maps to/impacts our planned Crew implementation inside the VSCode extension. Avoids verbatim duplication; focuses on actionable integration points.

## 1. Concept Layer Summary

| Concept | Distilled Essence | Control Surface | Reliability Levers | Cline Crew Mapping |
|---------|-------------------|-----------------|--------------------|--------------------|
| Router | Single structured decision among predefined paths | Schema / structured output / classification | Deterministic parsing, guardrails | Crew-level dispatcher (choose agent, or internal strategy path) |
| Structured Output | Constrains model response to schema (JSON / enum / union) | Parser + schema | Validation, fallback | Extend internal parsing util for agent/ tool selection |
| Tool-Calling Agent (ReAct-style loop) | Repeated perceive-think-act until termination condition | While loop orchestration | Stop criteria, tool whitelist, observation formatting | Existing Task loop; Crew orchestrator wraps multiple agent loops |
| Tool Calling | Model selects and populates function/tool inputs | Tool spec registry | Input validation, safe execution sandbox | Already present (MCP + internal tools); add per-agent allowlist |
| Memory (Short) | Step-local scratch state | In-loop state object | Size limits, pruning | Per-agent ephemeral working set |
| Memory (Long) | Cross-session / historical context recall | Persistence + retrieval | Summarization, decay | Global message history + planned Crew memory curator agent |
| Planning | Model self-produces multi-step plan & executes | Plan state (list of steps) | Re-planning triggers | Planner agent role + UI surfaced extracted plan |
| Human-in-the-Loop | Explicit pause for approval / injection | Interrupt points | Approval policy granularity | Existing tool approval; extend to crew phase gates (handoffs, plan approval) |
| Parallelization (Send) | Concurrent branch execution over shardable subtasks | Batch dispatch + join | Concurrency limits, error aggregation | Parallel worker agents (e.g. frontend/backend) with result aggregation node |
| Subgraphs | Nested graphs with isolated state that surface overlapping keys | Scoped state boundary | Interface contract (input/output keys) | Each agent = subgraph abstraction (later: pluggable) |
| Reflection | Post-action evaluation + feedback loop | Critique model / heuristic / deterministic checks | Eval rubric, retry budget | Reviewer / QA agent; integrate compile/test signals |
| Termination Condition | Decide when “enough” | Predicate on state / heuristic | Confidence threshold | Aggregator decides stop vs more refinement |
| State Checkpointing | Snapshot at each step for inspection / time travel | Durable store keyed by step | Pruning policy | Already in checkpoints; add per-agent trace identifiers |

## 2. Crew Architectural Mapping Enhancements

| Area | Current Plan Status | Enhancement From Doc | Action Item |
|------|---------------------|----------------------|-------------|
| Agent Selection | Implicit (selected Crew) | Introduce router schema for initial path choice | Define JSON schema + parser helper |
| Per-Agent Tool Policy | Not yet enforced | Tie into tool-calling concept with allowlists | Add `allowedToolIds` (derived from MCP server + internal tool group) |
| Memory Stratification | Conversation + future curator | Separate short-term scratch vs long-term | Add `agentRuntimeState` (ephemeral) vs persisted summaries |
| Parallel Execution | Conceptually planned | Formal Send API analogue | Introduce `CrewParallelBatch` executor with concurrency cap |
| Reflection | Reviewer agent optional | Embed deterministic checks (compile/test) as reflection signals | Add hook: `postAgentStepEvaluators` |
| Structured Outputs | Ad-hoc parsing | Central schema registry for routing & decisions | Utility: `StructuredDecision.parse<T>()` |
| Subgraph Isolation | Conceptual only | Explicit state projection (input filter/output merge) | Implement per-agent state adapter |
| Termination | Manual / single-task stop | Predicate: (goal satisfied OR retry budget exhausted) | Add `CrewTerminationPolicy` config |
| Human Approval | Tool approvals only | Phase approvals (plan, pre-exec, deploy) | Extend approval enum + UI toggles |
| Checkpoint Traceability | Global only | Tag per agent + phase for inspection | Extend checkpoint metadata: `agentId`, `phase` |

## 3. Data Model Adjustments (Additions)

(Proposed augmentations to `src/shared/Crew.ts` & forthcoming state keys)

```ts
// Additions (planned)
export interface CrewAgent {
  // existing fields ...
  allowedToolIds?: string[];          // Optional explicit tool allowlist
  parallelGroup?: string;             // For grouping in a parallel batch
  reflectionRole?: boolean;           // Marks as reflection/reviewer agent
}

export interface CrewExecutionPolicies {
  termination?: {
    maxAgentLoops?: number;
    confidenceKey?: string;          // Placeholder for future confidence signals
    requireReviewerApproval?: boolean;
  };
  approvals?: {
    requirePlanApproval?: boolean;
    requireReflectionGate?: boolean;
  };
  parallel?: {
    maxConcurrentAgents?: number;
  };
}

export interface Crew {
  // existing ...
  executionPolicies?: CrewExecutionPolicies;
}
```

## 4. Orchestration Flow (Refined)

1. Initialize Crew (load config, select execution mode).
2. Router Phase (structured decision):
   - Decide initial strategy path (e.g. plan-first vs direct-exec).
3. Planner Agent (if path includes planning):
   - Generate structured plan object (steps array).
   - Optional human approval (phase gate).
4. Parallel Worker Phase:
   - Partition plan steps or domains across agents (grouped by `parallelGroup`).
   - Dispatch concurrently (respect concurrency cap).
5. Aggregation / Integration Node:
   - Merge outputs → shared state (explicit merge strategy).
6. Reflection Phase (if enabled):
   - Reviewer / deterministic evaluators produce critique & fix directives.
   - If corrections needed and retry budget remains → loop to Worker Phase subset.
7. Termination Check:
   - Policy predicate satisfied → finalize answer.
   - Else continue refinement loop (bounded).
8. Finalization:
   - Persist per-agent deltas + aggregated summary.
   - Emit structured completion artifact (plan executed, decisions log).

## 5. Minimal Internal “Send” Analogue

We do not need full generalized Send API initially; implement:

```ts
interface ParallelDispatchTask {
  agentId: string;
  inputSlice: any;
}

async function executeParallelBatch(tasks: ParallelDispatchTask[], limit: number) {
  // simple pooled executor
}
```

State aggregator merges results keyed by `agentId`.

## 6. Structured Decision Utility (Routing / Meta Decisions)

```ts
interface RouteDecisionSchema {
  strategy: "plan_then_parallel" | "direct_execution";
  rationale: string;
}

function buildRoutePrompt(context: any): string { /* ... */ }

function parseRouteDecision(raw: string): RouteDecisionSchema {
  // Strict JSON parse + schema validation
}
```

(Extensible for other decision points: replan, escalate, terminate.)

## 7. Reflection Hooks

Types (planned):

```ts
interface ReflectionSignal {
  agentId: string;
  type: "compile_error" | "test_failure" | "lint_issue" | "review_comment";
  detail: string;
  severity: "info" | "warn" | "error";
}

interface ReflectionOutcome {
  proceed: boolean;
  actions?: Array<{ targetAgentId: string; directive: string }>;
}
```

Algorithm:
1. Collect signals after batch.
2. Reviewer agent (and/or deterministic evaluators) produce outcome.
3. If `proceed=false` and retry budget not exceeded → targeted re-dispatch directives.

## 8. Gap Analysis Introduced by This Mapping

| Gap | Impact | Mitigation Priority |
|-----|--------|---------------------|
| Schema enforcement utility absent | Risky parsing for routing | High |
| Per-agent tool allowlist not stored | Potential unsafe tool calls | High |
| Parallel execution pool absent | Serial performance bottleneck | Medium |
| Reflection signal channel undefined | Reviewer agent underpowered | Medium |
| Termination predicates simplistic | Infinite or premature loops | Medium |
| Subgraph state isolation (projection) missing | State leakage across agents | Medium |
| Approval phases limited to tool-level | Coarse-grained human oversight | Low-Medium |
| Memory layering (short vs long) unseparated | Context bloat / cost | Low (phase 2) |

## 9. Immediate Action Items (Next PRs)

1. Extend GlobalState additions (already planned) plus optional `executionPolicies`.
2. Introduce structured decision utility (routing & termination).
3. Add per-agent `allowedToolIds` support (derive from MCP selection UI or explicit list).
4. Implement simple parallel batch executor (promise pool).
5. Add reflection signal interfaces + stub integration points (compile/test future).
6. Tag checkpoints with `agentId` and `phase`.
7. Documentation update of new keys (this file + existing design doc cross-reference).

## 10. Cross-References

- Complements: `docs/langgraph_api_matrix.md` (primitive list)
- Builds on: `docs/langgraph_multi_agent_design.md` (base Crew architecture)
- Informs: Pending modifications to `state-keys.ts`, `state-helpers.ts`, controller CRUD for crews.

## 11. Incremental Delivery Strategy

Phase 1 (Foundations): State keys, default crew, execution mode, per-agent MCP/tool selection.
Phase 2 (Control): Router structured decision + parallel batch executor.
Phase 3 (Quality): Reflection hooks + reviewer cycle + termination predicates.
Phase 4 (Optimization): Subgraph isolation patterns, memory stratification, advanced approvals.
Phase 5 (Extensibility): Plugin-like subgraph/agent injection architecture.

---

Prepared to proceed with implementing state key extensions next (as previously queued).
