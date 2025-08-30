# LangGraph API Reference Matrix (Graph / State / Send / Checkpoint Layer)

Paraphrased + normalized from LangGraph public docs (agentic concepts, persistence, low-level graph). Use as internal evaluation artifact. Not verbatim reproduction.

## 1. Core Graph Construction

| Concept | Signature (Python) | Purpose | Notes |
|---------|--------------------|---------|-------|
| Define State schema | `class State(TypedDict): field: Type; list_field: Annotated[list[T], reducer]` | Declarative state shape | Reducers control merge semantics per key. Default = overwrite. |
| Graph builder | `workflow = StateGraph(State)` | Start mutable DSL | Generic over TypedDict schema. |
| Add node | `workflow.add_node(name_or_fn, fn=None)` | Register compute step | If `name_or_fn` is callable, name inferred (or pass explicit name + fn). Node fn: `def node(state: State) -> PartialStateDict | Iterable[Command]`. |
| Add edge | `workflow.add_edge(src, dst)` | Static sequencing | `START` / `END` sentinels supported. |
| Conditional edges | `workflow.add_conditional_edges(source, condition, path_map: dict[str,str])` | Dynamic single-branch routing | `condition(state) -> key` where key maps to destination node name (must exist). |
| Subgraph insertion | `workflow.add_node("team", compiled_subgraph)` | Hierarchical composition | Overlapping state keys allow communication (shared portions). |
| Compile | `graph = workflow.compile(checkpointer=None, store=None, serde=None, interrupt_before=None, interrupt_after=None, recursion_limit=..., concurrency=..., retry_policy=...)` | Produce executable graph | Inject persistence, memory store, serializer, human-in-loop interrupts, limits. |

## 2. Node Function Semantics

```python
def node(state: State) -> dict:
    # Return partial state updates (merged by reducers)
    return {"foo": "value", "items": ["x"]}

# Parallel fan-out (Send API) or tool invocations may instead return iterable of Command/Send objects.
```

Return types:
- `dict[str, Any]`: Partial update.
- `Iterable[Send | Command]`: Asynchronous / parallel dispatch instructions.
- Mixed lists of updates generally standardized into Commands internally.

## 3. State & Reducers

| Aspect | Mechanism | Behavior |
|--------|-----------|----------|
| Overwrite | Omit reducer | New value replaces old. |
| Accumulate list | `Annotated[list[T], add]` / `add_messages` | Extends list (append semantics). |
| Numeric accumulation | `Annotated[int, operator.add]` | Applies binary function `(current, incoming)`. |
| Custom reducer | `def merge(old, new) -> merged` referenced in Annotated | Arbitrary merge semantics. |
| Edit / fork semantics | `graph.update_state(config, updates: dict, as_node: str | None = None, checkpoint_id: str | None = None)` | Applies reducers; `as_node` tags origin; can branch from prior checkpoint. |

Reducer Precedence: Key-level reducer determines merge; absent => overwrite.

## 4. Execution Interfaces

| Method | Signature | Description |
|--------|-----------|-------------|
| Invoke (sync) | `graph.invoke(input_state: PartialState, config)` | Runs graph to terminal condition; returns final state snapshot. |
| Stream | `graph.stream(input_state, config, stream_mode=None)` | Yields incremental events (node start/finish, checkpoint, state deltas). |
| Async variants | `ainvoke`, `astream`, `abatch` | Async counterparts. |
| Batch | `graph.batch(list_of_inputs, config)` | Multiple inputs (may share thread IDs or not). |

`config` minimally: `{"configurable": {"thread_id": "<id>"}}` for persistence scoping.

## 5. Control Flow (Dynamic Routing)

| Pattern | Implementation | Notes |
|---------|----------------|-------|
| Router | Conditional edges + structured output | LLM returns a label; `condition()` maps to edge key. |
| Tool selection | LLM tool calling (`ChatModel.bind_tools([...])`) | Tools appear in model function schema. |
| While-loop planning | Repeated LLM node invocation until termination condition (e.g. model signals “final_answer”) | Termination often encoded as branching to END. |
| Reflection loop | Node decides re-run / revise by routing back to earlier node | Checkpointing allows rollback / analysis. |

## 6. Parallelization (Send API)

| Element | Signature | Purpose |
|---------|-----------|---------|
| Send class (conceptual) | `Send(target_node: str, payload: dict[str, Any])` | Declarative fan-out instruction. |
| Emitting parallel work | `return [Send("worker", {"item": x}) for x in items]` | Node returns list of Sends; framework processes concurrently (subject to concurrency limits). |
| Map-Reduce pattern | Map node emits Sends -> Worker node processes -> Reducer edge merges | Super-step barrier ensures all workers finish before aggregation. |
| Pending writes | Writes produced during parallel phase before global state merge | Tied to fault tolerance & checkpoint (partial completion). |

## 7. Subgraphs (Hierarchical Agents)

| Aspect | Behavior |
|--------|----------|
| Isolation | Subgraph maintains local state version of shared keys; merges on return. |
| Communication | Overlapping keys in parent & child schema propagate values (reducers apply). |
| Composition | Parent graph treats subgraph as a single node (can appear in edges, conditional edges). |
| Reusability | Subgraph pre-compiled once, reused across parents. |

## 8. Persistence & Checkpointing

| Concept | Interface / Field | Description |
|---------|-------------------|-------------|
| Checkpointer injection | `compile(checkpointer=BaseCheckpointSaverImplementation)` | Enables per-step durable state capture. |
| Super-step model | Graph state captured after each “super-step” (barrier after parallel fan-out) | Inspired by Pregel; ensures deterministic recovery points. |
| Thread scoping | `config["configurable"]["thread_id"]` | Namespaces checkpoint chain. |
| Snapshot type (conceptual) | `StateSnapshot` containing: `state`, `metadata (writes, step, ts, parent_id)` | Returned/queried for time travel. |
| Time travel / replay | Provide `checkpoint_id` to stream/invoke or fetch snapshot then continue | Deterministic reconstruction. |
| Forking | `update_state(..., checkpoint_id=old_id)` or start from historic snapshot | Divergent lineage from chosen point. |
| Partial write persistence | `put_writes` stores pending writes before merge | Supports fault tolerance in parallel phases. |

### BaseCheckpointSaver (Conceptual Interface)

```python
class BaseCheckpointSaver:
    def put(self, config: dict, checkpoint: Checkpoint) -> None: ...
    def put_writes(self, config: dict, writes: list[Write]) -> None: ...
    def get_tuple(self, config: dict) -> CheckpointTuple | None: ...
    def list(self, config: dict, *, limit: int = 20, before: str | None = None) -> Iterable[CheckpointTuple]: ...
    # Async variants: aput, aput_writes, aget_tuple, alist
```

Implementations: `InMemorySaver`, `SqliteSaver / AsyncSqliteSaver`, `PostgresSaver / AsyncPostgresSaver`.

### Serializer

| Serializer | Usage | Notes |
|------------|-------|-------|
| `JsonPlusSerializer` | Default JSON with fallback (pickle for unsupported types) | Simplicity; potential security risk if pickle fallback used; evaluate. |
| `EncryptedSerializer.from_pycryptodome_aes()` | AES-GCM encryption at rest | Requires `LANGGRAPH_AES_KEY` environment; secures checkpoints & writes. |
| Custom | Implement dumps/loads | Must remain deterministic + compatible with storage medium. |

## 9. State Editing / Live Intervention

| Action | API | Effect |
|--------|-----|--------|
| Edit current state | `graph.update_state(config, updates)` | Applies reducers; advanced for interventions. |
| Edit as node | `update_state(..., as_node="moderator")` | Metadata tags origin; can influence audit trails. |
| Branch from prior | `update_state(..., checkpoint_id="abc")` | Fork lineage & continue from modified snapshot. |

## 10. Memory Layers

| Layer | Mechanism | Scope |
|-------|-----------|-------|
| Short-term | In-graph `State` accumulation (e.g., messages list with reducer) | Per thread execution path. |
| Long-term (thread) | Checkpointer history (sequence of states) | Time travel, reflection, debugging. |
| Cross-thread / global | `Store` interface (e.g., `InMemoryStore(index={...})`) | User/application memory, semantic recall. |

### Store (Conceptual Interface)

```python
class BaseStore:
    def put(namespace: tuple[str, ...], key: str, value: dict | Any) -> None: ...
    def get(namespace, key) -> Any | None: ...
    def search(namespace, query: str, limit=K, filter: dict | None = None) -> list[Result]: ...
    def delete(namespace, key) -> None: ...
    def list(namespace, *, limit=50, cursor=None) -> list[Item]: ...
```

Semantic Index Config Example:

```python
store = InMemoryStore(index={
  "embed": embeddings_model,
  "dims": 1536,
  "fields": ["food_preference", "$"]  # "$" = full doc fallback
})
namespace = (user_id, "memories")
store.put(namespace, "m1", {"food_preference": "I like pizza"})
store.search(namespace, query="What does the user like to eat?", limit=3)
```

## 11. Tool Calling Integration

| Step | API | Result |
|------|-----|--------|
| Bind tools | `chat = ChatModel.bind_tools([func1, func2])` | Model system prompt updated w/ tool schemas. |
| Use in node | Node adds latest messages + observations; model output includes tool call(s) | Each tool call becomes structured JSON-like arguments. |
| Add observations | Tool outputs appended into reducer-merged `messages` list | Maintains full action/observation trace. |

Messages State Pattern:

```python
class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
```

## 12. Human-in-the-Loop

| Mechanism | Compile Args | Behavior |
|-----------|--------------|----------|
| Pre-node pause | `interrupt_before=["node_a", ...]` | Execution stops before listed node; external approver can inspect/modify state then resume. |
| Post-node pause | `interrupt_after=[... ]` | Pause after side effects but before next routing decision. |
| Manual edits | Combine pause + `update_state` | Enables approvals, corrections, compliance gating. |

## 13. Reflection Patterns

| Pattern | Implementation | Use Case |
|---------|----------------|----------|
| Self-eval loop | Node routes to evaluator node; evaluator sets flag requiring re-plan | Code generation, reasoning QA. |
| Deterministic feedback | Tool (e.g., compiler, linter) output appended to messages | Non-LLM structured correction. |
| Snapshot diff | Compare current state vs previous checkpoint | Detect regression / drift. |

## 14. Command / Send Abstractions (Conceptual)

| Class | Fields | Used By | Purpose |
|-------|--------|---------|---------|
| `Send` | `target: str`, `payload: dict` | Parallel fan-out nodes | Launch parallel logical branch. |
| `Command` | `kind: Literal["send","tool","halt",...]`, `data` | Internal scheduling | Unified scheduler representation. |

(Exact internal class names may differ; conceptual abstraction captured for build-vs-adopt parity evaluation.)

## 15. Configuration Surface Summary

| Dimension | LangGraph Option | Internal Build Consideration |
|-----------|------------------|------------------------------|
| Persistence | Pluggable checkpoint saver | Define clear interface & migration strategy; encryption boundary. |
| Memory | Dual: state (short-term), store (semantic/global) | Need vector index injection + embedding model plumbing. |
| Parallelization | Declarative `Send` + super-step merge | Scheduler + deterministic merge semantics + fault tolerance. |
| Routing | Conditional edges (pure functions) + LLM structured output | Need type-safe router middleware & schema validation. |
| Tooling | Native model tool calling integration | Build function schema registry + safe arg validation. |
| Human Control | Interrupt hooks pre/post node | Insertable breakpoints & resumable execution engine. |
| State Editing | `update_state` w/ reducers | Ensure audit log + lineage tracking. |
| Security | Encrypted serializer | Secrets management + rotation policy. |
| Introspection | Stream events (per node) | Observability bus (events, metrics). |

## 16. Potential Internal Gaps To Assess (Preview for Next Step)

| Capability | Provided by LangGraph | Gap Questions |
|------------|----------------------|---------------|
| Fine-grained ACL on memory | Not explicit | Need row-level / field masking? |
| Multi-tenant isolation | Namespaces + thread_ids | Hard guarantees (DB row constraints, KMS separation)? |
| Custom retry policies per node | Retry policy arguable | Do we require backoff strategies / circuit breakers? |
| Deterministic replays across model nondeterminism | Checkpoints yes; model randomness no | Do we need log of raw model inputs/outputs + seeds? |
| Observability metrics | Stream events | Need OpenTelemetry export, SLA dashboards? |
| Distributed execution scaling | Implicit (depends on saver impl) | Need queue-based worker sharding? |

---

## 17. Evaluation Mapping Keys (For Build-vs-Adopt Matrix)

Use these canonical labels:

- GRAPH_CONSTRUCTION
- STATE_SCHEMA
- REDUCERS
- EXECUTION_API
- ROUTING
- PARALLEL_SEND
- SUBGRAPHS
- PERSISTENCE
- STATE_EDIT_FORK
- MEMORY_STORE
- TOOL_CALLING
- HUMAN_LOOP
- REFLECTION
- SECURITY_SERIALIZATION
- OBSERVABILITY
- SCALING

These will anchor the comparative delta assessment in the next phase.

---

## 18. Quick Pseudocode Template (Holistic Example)

```python
class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    plan: str
    artifacts: Annotated[list[str], add]

def planner(state: AgentState):
    # produce or refine plan
    ...

def act(state: AgentState):
    # may emit tools or Sends
    ...

def reflect(state: AgentState):
    # decide continue or finish
    ...

wf = StateGraph(AgentState)
wf.add_node(planner)
wf.add_node(act)
wf.add_node(reflect)
wf.add_edge(START, "planner")
wf.add_conditional_edges("planner", choose_next, {"plan": "act"})
wf.add_conditional_edges("act", decide_next, {"reflect": "reflect", "done": END})
wf.add_conditional_edges("reflect", assess, {"replan": "planner", "done": END})

graph = wf.compile(
    checkpointer=SqliteSaver(conn, serde=EncryptedSerializer.from_pycryptodome_aes()),
    store=InMemoryStore(index={...}),
    interrupt_before=["act"],
)

config = {"configurable": {"thread_id": "u123"}}
final = graph.invoke({"messages": []}, config)
```

---

Prepared for subsequent build-vs-adopt gap analysis referencing section 15/16/17 labels.
