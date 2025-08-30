# Build vs Adopt Assessment: LangGraph vs Internal Orchestration Layer

Internal artifact. Paraphrased synthesis (no verbatim copying). References canonical capability keys from `langgraph_api_matrix.md`.

## 1. Scope Compared

| Domain | LangGraph Coverage | Internal Need (Assumed) | Delta Risk |
|--------|--------------------|-------------------------|------------|
| GRAPH_CONSTRUCTION | Mature DSL: nodes, edges, conditional edges, subgraphs | Declarative, auditable graph spec | Low |
| STATE_SCHEMA | TypedDict + per-key reducers | Strong typing, evolvable schemas with migrations | Medium (schema migration tooling) |
| REDUCERS | Built-in overwrite, list add, numeric ops, custom | Pluggable, testable merge semantics | Low |
| EXECUTION_API | invoke / stream / async / batch | Sync + async; backpressure; cancellation | Medium (cancellation/backpressure policy) |
| ROUTING | Pure function conditional edges + LLM structured output | Deterministic + policy guardrails | Medium (policy injection, allow/deny lists) |
| PARALLEL_SEND | Declarative `Send` fan-out; super-step barrier | Dynamic work partitioning, failure isolation | Medium (fine-grained retry per branch) |
| SUBGRAPHS | Hierarchical composition w/ overlapping keys | Namespaced multi-team agents | Low |
| PERSISTENCE | Pluggable checkpoint saver, time travel, forking | HA storage (cloud SQL / object store) | Medium (multi-region durability, migrations) |
| STATE_EDIT_FORK | update_state + checkpoint_id branching | Human intervention, lineage audit | Low |
| MEMORY_STORE | Store + semantic index hooks | Vector store bring-your-own + TTL + PII purge | Medium (compliance purge APIs) |
| TOOL_CALLING | Native ChatModel.bind_tools integration | Tool registry w/ auth + rate limits | High (governance layer absent) |
| HUMAN_LOOP | interrupt_before/after | Role-based approval workflow | High (RBAC + escalation) |
| REFLECTION | Pattern support via graph loops | Metrics-driven self-eval templates | Medium (library of evaluators) |
| SECURITY_SERIALIZATION | AES serializer option | KMS integration / key rotation / secret scope | Medium-High (enterprise controls) |
| OBSERVABILITY | Stream events; user can layer logs | Centralized tracing + metrics + replay UI | High (needs standardized OTEL export) |
| SCALING | Concurrency param + external DB backends | Horizontal worker pool; autoscaling; queue scheduling | High (distributed scheduler) |
| SCALING (cold start) | Lightweight Python overhead | Multi-language agent nodes | Medium (polyglot integration) |

## 2. Functional Coverage Summary

- Core orchestration (graph build, dynamic routing, parallel fan-out) is COMPLETE relative to typical needs.
- Advanced governance (RBAC on tool calls, audit policy injection) is PARTIAL.
- Enterprise observability, compliance (PII purge, key rotation automation) are GAPS.
- Distributed at-scale execution (sharded workers, queue-based load leveling) requires ADD-ON engineering.

## 3. Complexity & Effort Estimate (If Building In-House)

Rough person-month estimates (engineering + QA) to reach parity (95% confidence ranges):

| Capability Cluster | Net New Build Effort | Notes |
|--------------------|----------------------|-------|
| Minimal DSL (nodes/edges/reducers) | 1 - 1.5 PM | Core AST + compiler |
| Parallel send + deterministic barrier | 1 PM | Concurrency semantics, idempotence |
| Persistence (checkpoint, fork, time travel) | 2 - 3 PM | Schema evolution, migrations, encryption |
| Tool calling registry + validation | 1.5 - 2 PM | JSON schema, sandboxing |
| Memory store + semantic index plugin points | 1 - 1.5 PM | Vector abstraction + embeddings adapters |
| Human-in-loop pauses + resume | 0.5 - 1 PM | State freeze + resume tokens |
| Observability (event bus + UI) | 2 - 3 PM | Trace correlation, diff viewer |
| RBAC & governance | 1.5 - 2 PM | Policy engine + audit trails |
| Distributed execution (worker pool, queue, retries) | 2 - 4 PM | Leasing, heartbeat, backoff, idempotence |
| Security hardening (KMS rotation, secrets boundary) | 1 - 1.5 PM | Key lifecycle, compliance logging |
| Total (summed) | 14 - 22 PM | Does not include ongoing maintenance (15-25% annually) |

LangGraph adoption avoids ~70-80% of this upfront.

## 4. Time-To-Market (TTM) Impact

| Option | First Production (MVP) | Feature Parity | Opportunity Cost |
|--------|------------------------|----------------|------------------|
| Adopt LangGraph | 1-2 weeks (integration + guardrails) | Immediate (minus enterprise gaps) | Low |
| Build Internal | 3-4 months (MVP core) | 6+ months (parity) | High (delays domain features) |

## 5. Risk Analysis

| Risk Type | LangGraph Adopt | Internal Build |
|-----------|-----------------|----------------|
| Implementation defects | Lower (battle-tested primitives) | Higher (new domain scheduler bugs) |
| Hidden complexity (edge cases) | Externalized | Internal burden |
| Vendor lock-in | Moderate (DSL coupling) | None (full control) |
| Security review | Need to audit serializer, persistence backends | Full secure design responsibility |
| Performance scaling | May require patches / upstream PRs | Fully tunable but more engineering |

Mitigation for vendor lock-in: Abstract internal service layer around graph invocation + define translation mappers for state events.

## 6. Maintainability & Evolution

| Aspect | LangGraph | Internal |
|--------|-----------|---------|
| Upgrades | Track releases; regression tests | Self-manage roadmap |
| Bug fixes | Upstream PR or wait | Immediate patch capability |
| New paradigms (model features) | Likely added upstream quickly | Lag dependent on team bandwidth |
| Bus factor | Distributed community | Internal staffing risk |

## 7. Security & Compliance Considerations

Gap Areas if Adopting:
- Key rotation hooks (need wrapper over encrypted serializer).
- Tool call authorization (wrap tool binding with policy enforcement + allow/deny).
- Audit event normalization (convert stream events to structured log => OTEL).
- Data retention & purge (augment Store with TTL + purge index entries + checkpoint scrubbing).

All can be layered without forking core if extension points sufficient.

## 8. Extensibility Architecture Fit

LangGraph extension points:
- Checkpointer interface (PERSISTENCE)
- Store interface (MEMORY_STORE)
- Reducers (REDUCERS)
- Serializer pluggability (SECURITY_SERIALIZATION)

Internal required extensions:
- Tool Policy Middleware (pre-execution intercept)
- Event Export Adapter (OBSERVABILITY)
- Work Scheduler Adapter (for scaling beyond single runtime)

## 9. Cost Model

| Cost Component | Adopt | Build |
|----------------|-------|-------|
| Engineering (initial) | ~2 PM integration hardening | 14 - 22 PM |
| Maintenance Annual | ~1 PM (upgrade + patch wrappers) | 2 - 4 PM |
| Infrastructure | Similar (DB / vector store) | Similar |
| Opportunity Cost | Minimal | High |

## 10. Strategic Control vs Leverage

| Dimension | Favor Adopt | Favor Build |
|-----------|------------|-------------|
| Need rapid iteration on product features | ✔ |   |
| Core differentiation is orchestration tech |   | ✔ |
| Compliance customization critical | Partial (wrapper) | ✔ |
| Desire to open-source internal orchestrator |   | ✔ |
| Team size small / focused elsewhere | ✔ |   |

Current assumptions: differentiation lies in domain logic & proprietary tools, not generic orchestration — adopt is favored.

## 11. Recommendation

Adopt LangGraph core now; build thin **Orchestration Facade Layer** providing:
1. Policy & Governance: tool auth, rate limiting, safety classifiers.
2. Observability Bridge: transform stream events -> OTEL traces + metrics; maintain lineage graph in internal store.
3. Security Envelope: custom encrypted serializer with KMS rotation; periodic checkpoint purge jobs.
4. Scaling Wrapper: external queue (e.g., Redis/Cloud tasks) dispatching thread_ids to stateless LangGraph worker pods; checkpointer in durable SQL/Postgres.
5. Abstraction Interfaces: internal `Orchestrator` service that hides direct LangGraph types (ease future migration).

Evaluate build alternative only if:
- Need strict deterministic replays including model sampling seeds (currently gap).
- Need multi-language node execution runtime isolation at scale with per-node sandboxing.
- Regulatory demands require deeper guarantees than can be layered (e.g., field-level encryption inside state keys prior to serialization).

## 12. Immediate Adoption Work Plan (2-Week Sprint Outline)

| Day Range | Task | Output |
|-----------|------|--------|
| 1-2 | Spike & POC integration | Running sample graph w/ internal tool call |
| 3-4 | Facade & Policy middleware skeleton | `orchestrator.py`, tool registry |
| 5-6 | Observability exporter (stream -> OTEL) | Traces in monitoring stack |
| 7-8 | Secure serializer wrapper + KMS key mgmt | Rotatable key config |
| 9-10 | Queue-based scaling prototype | Worker autoscaling test |
| 11-12 | Compliance features (TTL, purge API) | Purge CLI & scheduled job |
| 13 | Load + failure testing scenarios | Report (latency, recovery) |
| 14 | Go / No-Go review + hardening backlog | Launch decision doc |

## 13. Key Metrics to Track Post-Adoption

- Mean node execution latency (p50/p95)
- Parallel fan-out saturation (active Sends / concurrency limit)
- Checkpoint write latency & size growth
- Tool call error rate & authorization denials
- Human-in-loop intervention frequency & approval SLAs
- Memory store semantic search precision (quality audits)
- Recovery time from simulated worker failure

## 14. Migration / Exit Strategy (Lock-In Mitigation)

- Maintain internal normalized event schema (avoid leaking LangGraph internal enums).
- Keep state schemas in independent package.
- Encapsulate graph construction in factories returning abstract `IOrchestratorGraph`.
- Version checkpoints with `meta: { schema_version }`.
- Shadow-run small internal prototype of alternative orchestrator for high-risk flows after stabilization (optional).

## 15. Recommendation Summary (Executive)

Adopt LangGraph now with thin governance + observability facade. Building in-house defers product roadmap significantly (4-6 month delay) with high engineering & reliability risk for limited strategic gain. Layer missing enterprise controls externally; reassess build decision only if future requirements demand deep non-layerable changes (deterministic seed replay, polyglot sandbox, stringent compliance beyond wrappers).

Decision: PROCEED WITH ADOPTION.
