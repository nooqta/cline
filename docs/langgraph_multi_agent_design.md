# Multi-Agent Implementation Design with LangGraph

Internal design document (paraphrased synthesis). Focus: pragmatic multi-agent orchestration using LangGraph primitives (SUBGRAPHS, PARALLEL_SEND, MEMORY_STORE, PERSISTENCE, HUMAN_LOOP, REFLECTION).

---

## 1. Objectives

- Orchestrate a coordinated set of specialized agents (Planner, ToolWorker(s), Reviewer/Reflection, Memory Curator, Moderator).
- Support dynamic task fan-out + aggregation.
- Allow hierarchical teams (manager agent supervising sub-team).
- Provide intervention points (human approval, state editing).
- Preserve lineage (forks, retries, audit) via checkpoints.
- Layer reusable evaluation & memory enrichment.

---

## 2. High-Level Architecture

```
User Query
  ↓
Planner (creates structured plan steps)
  ↓ conditional:
     - Parallel Dispatch (Send -> Worker for each step needing tools/data)
     - Direct Answer (if trivial)
Workers (tool-calling execution nodes)
  ↓
Result Aggregator (merges worker outputs; may compress / summarize)
  ↓
Reflection / Reviewer (quality / completeness / risk)
  ↺ (if needs revision) -> Planner OR specific Worker re-run
  ↓
Memory Curator (writes durable insights / semantic embeddings)
  ↓
Final Formatter (crafts user-facing response + rationale)
  ↓
END
```

Hierarchical extension: A “ResearchTeam” subgraph (Planner + multiple Workers + Aggregator + Reflection) embedded as a single node inside a higher-level “MetaCoordinator” graph that might chain additional phases (e.g., RiskAssessment, ComplianceCheck).

---

## 3. State Schema & Reducers

Design principles:
- Immutable event history (messages) accumulates.
- Derived summaries reduce token pressure (rolling_summary).
- Worker outputs collected in list with additive reducer.
- Plan is mutable (overwrite) because regenerations replace obsolete plan snapshot.
- Metrics tracked numerically with additive reducer.

```python
from typing import TypedDict, Annotated, List, Dict, Any
from operator import add
from langchain_core.messages import BaseMessage

# Custom reducers
def merge_dicts(old: dict | None, new: dict):
    merged = dict(old or {})
    merged.update(new or {})
    return merged

add_dicts = merge_dicts  # alias

class AgentState(TypedDict, total=False):
    messages: Annotated[List[BaseMessage], add]               # raw interaction log
    plan: str                                                 # current plan (overwrite)
    tasks: Annotated[List[dict], add]                         # list of task descriptors (append)
    pending_tasks: Annotated[List[dict], add]                 # backlog (append then consumed)
    worker_results: Annotated[List[dict], add]                # each worker output
    consolidated: dict                                        # aggregated results (overwrite)
    rolling_summary: str                                      # compression (overwrite)
    memory_writes: Annotated[List[dict], add]                 # structured memory entries
    metrics: Annotated[dict, add_dicts]                       # counters (merged per key)
    reflection: str                                           # last reflection notes
    final_answer: str                                         # produced when ready
    control_signal: str                                       # router directive
```

Key control values for `control_signal` (ROUTING):
- "dispatch" — proceed to worker fan-out
- "answer" — skip to final formatting
- "revise_plan" — loop back to Planner
- "retry_workers" — selective worker re-execution
- "finish" — terminate at FINAL

---

## 4. Node Responsibilities

| Node | Purpose | Output Keys |
|------|---------|-------------|
| planner | Produce / refine plan + derive task list | plan, tasks, control_signal |
| dispatcher | Select tasks to execute now; emit Sends per task | (Sends -> worker) |
| worker | Execute tool calls for one task; produce structured result | worker_results (+ messages) |
| aggregator | Merge worker_results into consolidated + update rolling summary | consolidated, rolling_summary |
| reviewer (reflection) | Assess quality/gaps; set control_signal; optionally inject reflection text | reflection, control_signal |
| memory_curator | Distill durable facts; produce memory_writes | memory_writes |
| final_formatter | Craft final_answer | final_answer |
| moderator (optional) | Human-in-loop intercept / policy enforcement | (may edit multiple fields) |

---

## 5. Routing Logic

- Planner sets `control_signal`.
- Conditional edges from planner: 
  - "dispatch" → dispatcher
  - "answer" → final_formatter
- Reviewer sets `control_signal`:
  - "revise_plan" → planner
  - "retry_workers" → dispatcher
  - "finish" → final_formatter
  - fallback → aggregator (if more accumulation needed)

---

## 6. Parallel Fan-Out with Send

Dispatcher node:

```python
from langgraph.types import Send

def dispatcher(state: AgentState):
    # Select subset of unprocessed tasks
    remaining = [t for t in state.get("tasks", []) if not t.get("done")]
    batch = remaining[: state.get("config", {}).get("max_parallel", 4)]
    sends = []
    for task in batch:
        payload = {"task": task}
        sends.append(Send("worker", payload))
    if not sends:
        return {"control_signal": "answer"}  # nothing to do
    return sends
```

Worker node returns partial state update:

```python
def worker(state: AgentState):
    task = state["task"]  # isolated payload from Send
    # Call tools via bound chat model
    # ...
    result = {
        "id": task["id"],
        "status": "complete",
        "output": "...",
        "evidence": [...],
    }
    return {"worker_results": [result], "messages": [/* new observation messages */]}
```

Barrier semantics: After all parallel `worker` executions complete, framework merges updates; aggregator node can then consolidate.

---

## 7. Aggregation Strategy

Consolidation can be incremental to stay scalable:

```python
def aggregator(state: AgentState):
    consolidated = dict(state.get("consolidated", {}))
    for r in state.get("worker_results", []):
        consolidated[r["id"]] = r
    # Optional summarization to control token growth
    summary = summarize_results(list(consolidated.values()))
    return {"consolidated": consolidated, "rolling_summary": summary, "control_signal": "review"}
```

---

## 8. Reflection / Review Loop

```python
def reviewer(state: AgentState):
    gaps = detect_gaps(state["consolidated"], state.get("plan",""))
    if gaps.missing_tasks:
        # Add new tasks
        new_tasks = [{"id": g, "desc": g} for g in gaps.missing_tasks]
        return {
            "tasks": new_tasks,
            "reflection": gaps.explanation,
            "control_signal": "dispatch"
        }
    if gaps.needs_replan:
        return {"reflection": gaps.explanation, "control_signal": "revise_plan"}
    if gaps.low_confidence:
        return {"reflection": gaps.explanation, "control_signal": "retry_workers"}
    return {"reflection": "All criteria satisfied", "control_signal": "finish"}
```

---

## 9. Memory Curation

Executed after reviewer signals "finish" but before final answer:

```python
def memory_curator(state: AgentState):
    distilled = extract_facts(state["consolidated"])
    return {"memory_writes": distilled}
```

Memory ingestion:

```python
for fact in distilled:
    store.put( (state['user_id'], "memories"), fact["id"], fact)
```

Semantic index configured at compile time with embeddings model.

---

## 10. Human-in-the-Loop Integration

Compile with:

```python
graph = wf.compile(
  checkpointer=SqliteSaver(conn, serde=EncryptedSerializer.from_pycryptodome_aes()),
  store=store,
  interrupt_before=["dispatcher", "final_formatter"],
  interrupt_after=["planner"]
)
```

Flow:
1. After planner completes (`interrupt_after`), human can inspect & edit plan via `update_state`.
2. Before dispatcher runs, human can reject specific tasks (`interrupt_before`).
3. Before final_formatter, human can edit consolidated answer.

---

## 11. Checkpoint / Fork Scenarios

Use cases:
- Branch alternative plan: `update_state(config, {"plan": alt_plan}, checkpoint_id=prior_checkpoint)`
- Retry subset of workers: Clear results for targeted tasks + set `control_signal="dispatch"`.

Audit lineage preserved by checkpointer metadata (step, parent_id).

---

## 12. Observability Event Mapping

Stream event categories to internal telemetry:

| Event Type (LangGraph) | Internal Channel | Metrics |
|------------------------|------------------|---------|
| node_start             | trace span start | per-node latency |
| node_end               | trace span end   | success/failure count |
| checkpoint             | artifact log     | checkpoint size, delta keys |
| stream_update          | live console     | token usage (if instrumented) |

Wrap execution:
- Convert each event into OTEL span with attributes: `thread_id`, `node`, `checkpoint_id`, `control_signal`.

---

## 13. Failure / Retry Policy

Custom policy wrapper (pseudo):

```python
RETRYABLE_NODES = {"worker"}

def on_node_error(node_name, error, attempt):
    if node_name in RETRYABLE_NODES and attempt < 3:
        return "retry"
    return "fail"
```

Integrate via compile-time retry policy (if available) or manual wrapper invoking node function.

---

## 14. Security / Governance Extensions

| Concern | Strategy |
|---------|----------|
| Tool authorization | Pre-execution decorator validating tool id against user scope |
| PII leakage | Redactor pass over outgoing tool arguments and final answer |
| Key rotation | KMS-managed key; reconstruct EncryptedSerializer at process start |
| Memory purge | TTL metadata on memory_writes; scheduled job deletes expired + semantic index entries |

---

## 15. Example Assembly Code

```python
from langgraph.graph import StateGraph, START, END

wf = StateGraph(AgentState)

wf.add_node("planner", planner)
wf.add_node("dispatcher", dispatcher)
wf.add_node("worker", worker)
wf.add_node("aggregator", aggregator)
wf.add_node("reviewer", reviewer)
wf.add_node("memory_curator", memory_curator)
wf.add_node("final_formatter", final_formatter)

# Linear & conditional edges
wf.add_edge(START, "planner")
wf.add_conditional_edges(
    "planner",
    lambda s: s.get("control_signal"),
    {
      "dispatch": "dispatcher",
      "answer": "final_formatter"
    }
)
wf.add_edge("dispatcher", "worker")              # Send fan-out -> worker
wf.add_edge("worker", "aggregator")              # Barrier ensures all workers done
wf.add_edge("aggregator", "reviewer")
wf.add_conditional_edges(
    "reviewer",
    lambda s: s.get("control_signal"),
    {
      "revise_plan": "planner",
      "retry_workers": "dispatcher",
      "dispatch": "dispatcher",
      "finish": "memory_curator"
    }
)
wf.add_edge("memory_curator", "final_formatter")
wf.add_edge("final_formatter", END)

graph = wf.compile(
    checkpointer=SqliteSaver(sql_conn, serde=EncryptedSerializer.from_pycryptodome_aes()),
    store=store,
    interrupt_before=["dispatcher", "final_formatter"],
    interrupt_after=["planner"]
)

config = {"configurable": {"thread_id": "user-123"}}
result = graph.invoke(
    {"messages": [], "plan": "", "control_signal": "dispatch"},
    config
)
```

---

## 16. Subgraph Hierarchy Pattern

Encapsulate inner research loop:

```python
research_wf = StateGraph(AgentState)
# (add planner, dispatcher, worker, aggregator, reviewer)
research_graph = research_wf.compile(checkpointer=..., store=...)

parent_wf = StateGraph(AgentState)
parent_wf.add_node("research_team", research_graph)  # subgraph as node
parent_wf.add_node("final_formatter", final_formatter)
parent_wf.add_edge(START, "research_team")
parent_wf.add_edge("research_team", "final_formatter")
parent_wf.add_edge("final_formatter", END)
```

Shared keys (e.g., messages, consolidated) propagate automatically via reducers.

---

## 17. Reflection Enhancements

Techniques:
- Confidence scoring: model returns structured JSON with `confidence` ∈ [0,1]; threshold drives loops.
- Delta-based reflection: compare diff of `consolidated` between last two checkpoints; if unchanged over N loops, force finish.
- Deterministic evaluators: run static analyzers / test harness and convert results to pseudo-messages for reviewer.

---

## 18. Token & Cost Management

Strategies:
- Rolling compression every aggregator pass (update `rolling_summary`).
- Planner & reviewer consume `rolling_summary` + latest deltas instead of full messages.
- Memory curator writes only normalized fact frames (subject, predicate, object, provenance).

---

## 19. Operational Runbook (Core)

| Scenario | Action |
|----------|--------|
| Add new specialized worker | Implement node fn; extend dispatcher selection; maybe tag task type |
| Hotfix incorrect plan mid-run | Pause (interrupt), `update_state` modify plan & tasks, set control_signal="dispatch" |
| Retry subset after transient failure | Remove their result entries + re-add tasks; set control_signal="dispatch" |
| Rollback to earlier concept | Provide older checkpoint_id; fork and proceed; mark lineage metadata |
| Purge user data | Delete store namespace; remove checkpoints (matching thread_id) |

---

## 20. Build Checklist for Implementation

1. Define state and reducers (above).
2. Implement node functions (planner → final_formatter).
3. Implement task selection + dispatcher with Send.
4. Add reflection policies (reviewer).
5. Integrate memory store (semantic index).
6. Configure checkpointer + encryption.
7. Add human-in-loop interrupts.
8. Add observability export.
9. Load test parallel fan-out (latency & merge).
10. Document operational procedures.

---

## 21. Extension Hooks (Future)

| Hook | Purpose |
|------|---------|
| pre_node(node_name, state) | Policy / rate limiting |
| post_node(node_name, delta) | Metrics & anomaly detection |
| tool_arg_filter(tool_name, args) | Sanitization / PII |
| memory_fact_validator(fact) | Consistency enforcement before store.put |

---

## 22. Summary

LangGraph provides all core primitives needed for a robust multi-agent system:
- Parallelism via Send
- Hierarchy via subgraphs
- Persistence for lineage / forks
- Reducers for incremental memory
- Human-in-loop interrupts
- Flexible routing loops enabling reflection

Thin layers required: policy middleware, observability mapping, memory governance, enhanced retry semantics.

This design can be implemented incrementally—starting with Planner → Workers → Aggregator → Final path, then adding reflection, memory curation, and hierarchical subgraphs.
