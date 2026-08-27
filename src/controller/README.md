# Browser controller modules

The runtime in `runtime.ts` is the sole owner of mutable controller state. Domain operation objects are installed on that one prototype; they do not retain parallel state. The root `src/browser-controller.ts` is the stable public import.

Every worker command has exactly one compile-time owner in `protocol/command-contracts.ts`. Every public MCP tool—including host recovery and Lounge coordination—also has exactly one owner in `mcp/tool-contracts.ts`, and registration names come from `mcp/tool-names.ts`. The owners cover action families rather than website-specific widgets:

| Manager | Responsibility |
| --- | --- |
| lifecycle | runtime, profile, process ownership, start/switch/stop |
| perception | bounded page/frame/text/visual/diagnostic evidence |
| navigation | URL/history transitions and readiness |
| tab | stable identity, selection, passive inspection, restore, close |
| interaction | click, hover, focus, keys, double/context click, drag, scroll |
| form | redacted summary, fills, controls/options, checks, staged plans |
| transfer | observed file inputs, unproven workflow-persistence state, and durable sanitized download capture |
| dialog | alert/confirm/prompt/beforeunload response and history |
| private handoff | field-scoped private input and authenticated reattachment |
| policy | optional agent-declared semantic review boundaries |
| recovery | deadlines, operation status, zero-input recovery, worker replacement |

Adding a protocol command without assigning its manager, phase system, dispatch class, replay policy, and review-policy class is a TypeScript error. The exhaustive technique vocabulary and manager responsibilities live in `protocol/capabilities.ts`; `protocol/command-contracts.ts` is the command-to-manager source of truth.

The coordination manager owns Lounge membership, delivery, acknowledgement, presence, notices, and audited history. It never owns browser input or user authority. Host-level reservation, operation status, and worker recovery belong to the recovery manager.

Consequential element/file input belongs to `ActionPhaseManager` or a workflow that delegates every physical step to it. Bounded scrolling, navigation, lifecycle, private handoff, and recovery retain specialized state machines because their valid transitions differ.

## Context and persistence

`runtime.ts` owns one scoped context. The canonical layer model is exported as `BROWSER_CONTEXT_LAYERS`:

- durable: ownership lease, operation terminal journal, Lounge state, sanitized download/dialog manifests, and exact-document value-free page risk;
- session: controlled runtime/profile, stable tab selection, policy, and handoff state;
- document: frame/document versions and one-use snapshot/form/control capabilities;
- action: deadline, phases, exact handles, dispatch evidence, postconditions, and dialog expectation;
- private ephemeral: values used only at the dispatch or human-handoff boundary and never retained.

Website-specific business meaning does not belong in these managers. New UI variation should compose the existing techniques; add a new generic technique only when a disposable fixture demonstrates a genuinely missing physical or observation primitive.
