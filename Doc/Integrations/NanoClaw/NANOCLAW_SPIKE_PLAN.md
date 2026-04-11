# AgentHiFive + NanoClaw Spike Plan

## Goal

Validate the smallest viable AgentHiFive integration for NanoClaw with minimal changes to NanoClaw itself.

The spike should prove that:

- NanoClaw remains the runtime and conversation loop
- AgentHiFive remains an optional protected backend
- approval-sensitive external actions can use adapter-owned exact replay
- approval outcomes can be delivered back into the originating NanoClaw conversation

This spike is deliberately limited to **AH5-backed data/tool access**.

It does **not** attempt to solve:

- AH5-backed LLM routing
- AH5-backed channels
- generalized NanoClaw plugin architecture
- replacing OpenCLI/OneCLI

## Why Spike First

NanoClaw is small, direct, and intentionally customized by code changes. That makes it a good fit for a narrow spike, but a poor fit for speculative integration layers.

Before designing a fuller adapter, we need to verify three assumptions:

1. We can route selected protected actions through AgentHiFive without disrupting NanoClaw's normal agent loop.
2. We can keep approval redemption adapter-owned rather than model-owned.
3. We can inject the resolved approval result back into the correct NanoClaw conversation with acceptable UX.

If those assumptions hold, Phase 1 is viable.

## Architectural Reality Check

NanoClaw is not structured like nanobot.

The important difference is that the agent runtime lives inside an isolated container, while orchestration, container launch, and credential plumbing live on the host side.

That means:

- the AH5 adapter should live on the **host side**, not inside the container
- approval tracking should happen on the **host-side tool transport path**
- result delivery should go back through NanoClaw's **IPC mechanism**, not an in-process MessageBus
- the spike must validate the host/container boundary as much as it validates AH5 semantics

This is the key reason to spike before designing a fuller integration.

## Proposed Integration Model

Use a **small AH5-specific TypeScript adapter** plus one or two narrow NanoClaw integration points on the host side.

The adapter owns:

- capturing approval-required AH5 requests
- persisting exact original payloads
- polling approval state
- replaying the exact stored payload with `approvalId`
- formatting and reinjecting the result

NanoClaw owns:

- the normal runtime, orchestration, and conversation loop
- native tools, native channels, native model routing
- deciding when to call AH5-backed tools
- moving messages and tool traffic between the host and the container

## Non-Goals

- No attempt to make AH5 the universal credential gateway for NanoClaw
- No broad refactor of NanoClaw's architecture
- No mandatory dependency on AH5 for normal NanoClaw installs
- No upstream-style abstraction unless the spike proves it is needed

## Minimal-Touch Design

The preferred spike shape is:

1. Add `agenthifive-nanoclaw/` as a small local TypeScript adapter module.
2. Integrate it at the **host-side IPC/MCP transport seam**, not inside the containerized agent runtime.
3. Add one thin reinjection point to feed approval outcomes back into the active conversation through NanoClaw's per-group IPC path.

This keeps AH5-specific logic co-located and minimizes NanoClaw churn.

## Likely Integration Surface

For the spike, the cleanest path is likely:

1. expose AH5-backed tools to the agent through NanoClaw's existing host/container IPC tool bridge
2. observe requests and results at that bridge layer
3. let the host-side AH5 adapter own approval tracking and replay
4. deliver the resolved result back into the group via IPC so the containerized agent sees it on the next turn

This is preferable to trying to add AH5 logic directly inside the containerized agent runner.

## Candidate Spike Flow

### Happy path

1. User asks NanoClaw to perform an AH5-backed external action.
2. The containerized agent invokes an AH5-backed tool.
3. The tool call crosses the host/container boundary through NanoClaw's IPC/MCP path.
4. The host-side AH5 adapter sends the request to AgentHiFive.
5. AgentHiFive returns either:
   - an immediate execution result, or
   - `approvalRequired: true` with `approvalRequestId`
6. The host-side adapter stores:
   - `approvalRequestId`
   - the exact original request payload
   - NanoClaw session/conversation routing context
7. Background poller checks approval status.
8. On approval:
   - adapter replays the exact stored payload with `approvalId`
   - AgentHiFive validates fingerprint and executes
   - adapter injects the result into the original NanoClaw conversation via IPC
9. NanoClaw agent formats the result naturally for the user.

### Denial / expiry

1. Poller detects `denied` or `expired`.
2. Adapter injects a synthetic status message into the original conversation via IPC.
3. NanoClaw agent explains the outcome to the user.

## Smallest Possible Scope

Pick one protected external action path only.

Recommended first example:

- one AH5-backed HTTP execution tool against a real external provider behind the vault

Good examples:

- list a SaaS resource through `execute`
- fetch available models through an AH5-backed provider connection
- read-only provider call first, then one approval-gated write call

Avoid broad tool coverage in the spike.

## Success Criteria

The spike is successful if all of the following are true:

1. **Normal NanoClaw behavior remains intact**
   Native flows still work when AH5 is absent or disabled.

2. **AH5-backed tool call works**
   A selected action can execute through AgentHiFive and return real provider data.

3. **Approval-required flow works**
   An approval-gated action produces `approvalRequired` and is tracked automatically.

4. **Adapter-owned replay works**
   After approval, the adapter replays the exact stored payload without asking the model to regenerate it.

5. **Result reinjection works**
   The approval result reaches the original conversation without requiring a follow-up user message.

6. **Restart resilience works**
   Pending approvals survive a NanoClaw restart.

7. **Tampered replay fails**
   If the replay payload is altered, AgentHiFive rejects it.

## Failure Criteria

The spike should be considered failed or incomplete if:

- the model must regenerate the request after approval
- there is no reliable way to route approval results back into the right conversation
- the required NanoClaw changes spread across unrelated subsystems
- enabling AH5 materially disturbs non-AH5 flows

## Suggested File/Module Shape

The exact filenames may change depending on NanoClaw internals, but the target shape should be:

- `agenthifive-nanoclaw/types.ts`
- `agenthifive-nanoclaw/vault-client.ts`
- `agenthifive-nanoclaw/pending-store.ts`
- `agenthifive-nanoclaw/approval-poller.ts`
- `agenthifive-nanoclaw/result-injector.ts`
- `agenthifive-nanoclaw/ipc-mcp-wrapper.ts`
- `agenthifive-nanoclaw/adapter.ts`

NanoClaw changes should ideally be limited to:

- adapter initialization
- session/conversation context capture
- host-side IPC/MCP wrapper integration
- result reinjection via group IPC

## Tool Exposure Strategy

NanoClaw does not use MCP in the same way nanobot does. The agent runs inside the container using the Claude Agent SDK, while host functionality is typically surfaced to the container through NanoClaw's IPC bridge.

For the spike, the most likely clean path is:

- expose AH5-backed tools through the existing host-side IPC/MCP stdio bridge

Concretely, that means:

1. the container-side MCP server defines one or more AH5-backed tools
2. those tool invocations forward to the host through IPC
3. the host-side adapter calls AgentHiFive
4. the host-side adapter returns the immediate result or approval-required response back through the same bridge

The container should **not** call AgentHiFive directly in the spike. That would conflict with NanoClaw's credential and isolation model.

Why this is attractive:

- it keeps AH5-specific execution on the host side
- it avoids putting approval logic inside the container
- it gives the host bridge visibility into both tool calls and tool results
- it is conceptually closest to what already worked in the nanobot spike

Alternative:

- add AH5-backed Claude Agent SDK tools directly in the containerized agent runner

This is less attractive for the spike because approval tracking and replay would then be farther away from the host-side conversation and IPC machinery.

## Verified Patch Map

Based on the current upstream NanoClaw code, the most relevant files are now known rather than guessed.

### Primary host-side files

- `src/index.ts`
  Top-level lifecycle and subsystem wiring. This is where `startIpcWatcher(...)` is called and where adapter startup/shutdown wiring is most likely to belong.
- `src/ipc.ts`
  Verified host-side IPC processing layer. This watches per-group IPC folders and processes `messages/` and `tasks/` files. It is the clearest reinjection surface on the host side.
- `src/container-runner.ts`
  Verified host/container boundary. This mounts per-group IPC into `/workspace/ipc`, copies the agent runner source into the container, and calls `onecli.applyContainerConfig(...)`.

### Verified container-side bridge files

- `container/agent-runner/src/ipc-mcp-stdio.ts`
  Verified MCP stdio bridge that exposes host capabilities to the Claude Agent SDK inside the container. This is the strongest candidate seam for AH5-backed tool exposure in the spike.
- `container/agent-runner/src/index.ts`
  Verified container runner. It registers the `nanoclaw` MCP server with the Claude Agent SDK and points it at `ipc-mcp-stdio.js`. This file is important context, but should ideally need little or no modification in the spike.

### Secondary files

- `src/router.ts`
  Only if synthetic approval-result messages need special outbound formatting.
- `src/group-queue.ts`
  Only if reinjection timing interacts with active container sessions in a way the existing IPC path does not already handle.

### New adapter files

- `src/agenthifive-nanoclaw/adapter.ts`
- `src/agenthifive-nanoclaw/types.ts`
- `src/agenthifive-nanoclaw/vault-client.ts`
- `src/agenthifive-nanoclaw/pending-store.ts`
- `src/agenthifive-nanoclaw/approval-poller.ts`
- `src/agenthifive-nanoclaw/result-injector.ts`
- `src/agenthifive-nanoclaw/ipc-mcp-wrapper.ts`

These filenames are meant to keep AH5 logic co-located and obviously removable if the spike is abandoned.

### Evidence for this patch map

The verified reasons these files matter are:

- `container/agent-runner/src/index.ts` already starts the Claude Agent SDK with `mcpServers.nanoclaw`
- `container/agent-runner/src/ipc-mcp-stdio.ts` already defines MCP tools that write host-readable IPC files
- `src/ipc.ts` already consumes those IPC files on the host side and can already send messages back to channels
- `src/container-runner.ts` already defines the OneCLI seam and the mounted `/workspace/ipc` boundary

So the spike should be designed around the existing host/container transport rather than inventing a new one.

## Smallest Viable Patch Set

The spike should aim for the smallest patch set that can prove the model end to end.

### Patch 1: Host-side adapter bootstrap

Add adapter startup and shutdown wiring at the host layer.

Responsibilities:

- initialize the AH5 adapter only when explicitly configured
- start the approval poller
- stop it on shutdown

Most likely file:

- `src/index.ts`

Success condition:

- NanoClaw runs unchanged when AH5 config is absent
- NanoClaw starts the adapter cleanly when AH5 config is present

### Patch 2: AH5 tool exposure through the host bridge

Expose one AH5-backed tool path to the containerized agent.

Preferred implementation:

- add AH5 tool exposure through the existing IPC/MCP stdio bridge

Most likely files:

- `container/agent-runner/src/ipc-mcp-stdio.ts`
- `src/ipc.ts`
- `src/agenthifive-nanoclaw/ipc-mcp-wrapper.ts`

Responsibilities:

- register one or a few AH5-backed MCP tools in the container-side bridge
- forward those tool requests from the container to the host over IPC
- have the host-side wrapper call AgentHiFive
- return immediate success results normally
- return approval-required responses without losing payload information

Success condition:

- the agent can invoke one AH5-backed tool and receive a real result

### Patch 3: Approval capture at the host bridge

Capture approval-required responses where the host has both:

- the original request payload
- the group/session routing context

Responsibilities:

- detect `approvalRequired`
- persist `{ approvalRequestId, originalPayload, routingContext }`
- avoid requiring model cooperation for replay

Most likely files:

- `src/ipc.ts`
- `src/agenthifive-nanoclaw/ipc-mcp-wrapper.ts`

Success condition:

- an approval-gated AH5 tool call is automatically tracked by the adapter

Clarification:

- the container-side MCP tool definition is only the agent-facing entrypoint
- the host-side IPC/MCP wrapper is where approval tracking should actually happen
- that host-side layer should own the original payload, routing context, and replay registration

### Patch 4: Host-side replay and result reinjection

Replay the exact payload after approval and reinject the outcome via IPC.

Responsibilities:

- poll AH5 approval state
- replay the stored exact payload with `approvalId`
- inject either:
  - execution result
  - denial message
  - expiry message

Most likely files:

- `src/agenthifive-nanoclaw/approval-poller.ts`
- `src/agenthifive-nanoclaw/result-injector.ts`
- `src/ipc.ts`

Success condition:

- the result reaches the originating conversation without a fresh user prompt

### Patch 5: Restart resilience

Persist pending approvals on disk.

Responsibilities:

- store pending approval state in a host-side file
- reload on restart
- resume polling automatically

Most likely files:

- `src/agenthifive-nanoclaw/pending-store.ts`
- `src/index.ts`

Success condition:

- pending approvals survive a NanoClaw restart

## Suggested Execution Order

To keep the spike low-risk, build it in this order:

1. identify the exact host-side bridge file where container tool traffic passes
2. expose one trivial AH5-backed read operation
3. confirm routing context is available at the same layer
4. add approval capture and persistence
5. add replay
6. add IPC reinjection
7. test restart resilience
8. test tamper rejection

Do not start by building all adapter files at once. Confirm the bridge seam first.

## Implementation Checklist

### Step 1: Confirm the exact wrapper point inside the verified bridge

The bridge seam is now known at a file level. The remaining question is which function boundary inside that seam is best for wrapping AH5-backed tools.

Verify:

- where `ipc-mcp-stdio.ts` registers tools
- whether AH5-backed tools should be added directly there or delegated to `src/agenthifive-nanoclaw/ipc-mcp-wrapper.ts`
- whether the wrapper can preserve original request payload plus routing context

Output:

- one short note naming the exact function or tool-registration block to wrap

### Step 2: Add a minimal AH5 execution path

- wire one AH5-backed tool into the host bridge
- call a read-only AH5-backed action first
- verify the containerized agent can use it successfully

Output:

- one successful end-to-end read demo

### Step 3: Add approval capture

- detect `approvalRequired`
- store original payload and routing context
- log tracked approvals for debugging

Output:

- one pending approval file on disk with correct payload and routing context

### Step 4: Add replay

- poll approval status
- replay exact payload with `approvalId`
- surface replay errors distinctly

Output:

- one successful approved replay

### Step 5: Add IPC reinjection

- inject a synthetic inbound message or equivalent via the host-side IPC path
- verify it lands in the correct group/session
- keep the formatting deliberately simple for the spike

Output:

- one automatically delivered approval result in the original conversation

### Step 6: Harden with restart + tamper tests

- restart NanoClaw with a pending approval
- confirm polling resumes
- confirm tampered payloads fail with fingerprint rejection

Output:

- one restart demo
- one tamper-rejection demo

## Residual Risks

Even with the improved plan, these are still the main spike risks:

- the existing host/container bridge may not expose enough routing context without a small protocol extension
- IPC reinjection may be possible but awkward from a UX perspective
- the existing bridge may normalize tool responses in a way that obscures `approvalRequired`
- the Claude Agent SDK tool loop may not surface IPC-injected approval outcomes until the next agent turn, rather than behaving like an immediate in-band continuation
- NanoClaw may require a slightly deeper host-side abstraction than we want for clean tool wrapping

These are acceptable spike risks, because discovering them early is exactly the point of the exercise.

## Estimated Scope

Rough estimate for the spike:

- `800-1200` lines of TypeScript total

Likely breakdown:

- `250-400` lines for the host-side AH5 adapter
- `150-250` lines for approval polling and persistence
- `150-250` lines for IPC/MCP wrapper and host forwarding
- `100-200` lines for reinjection and glue changes
- small focused changes in existing NanoClaw files

This is likely somewhat larger than the nanobot spike because NanoClaw adds a host/container transport boundary, even though the underlying AH5 approval model is already validated.

## Smallest Viable Pseudo-Patch

This section is intentionally concrete. It is not final code, but it should be close enough to drive implementation without rethinking the architecture again.

### 1. `container/agent-runner/src/ipc-mcp-stdio.ts`

Add one new MCP tool for the spike, for example:

- `agenthifive_execute`

Responsibility:

- accept the same narrow arguments we need for the spike
- write a host-readable IPC request file
- wait for the matching host-side response file
- return the response back to the Claude Agent SDK

Suggested request payload shape:

```ts
{
  type: "agenthifive_execute",
  requestId: string,
  chatJid: string,
  groupFolder: string,
  timestamp: string,
  payload: {
    connectionId?: string,
    service?: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    query?: Record<string, string>,
    headers?: Record<string, string>,
    body?: unknown
  }
}
```

Suggested response payload shape:

```ts
{
  requestId: string,
  ok: boolean,
  result?: unknown,
  error?: string
}
```

Implementation note:

- use the same atomic file-write pattern already used in `ipc-mcp-stdio.ts`
- create a dedicated IPC subdirectory for AH5 requests and responses rather than overloading the existing `messages/` or `tasks/` flows

Recommended new IPC directories:

- `/workspace/ipc/agenthifive-requests`
- `/workspace/ipc/agenthifive-responses`

### 2. `src/ipc.ts`

Extend the host-side IPC watcher to process the new AH5 request directory.

Responsibilities:

- read AH5 request files from each group's IPC namespace
- authorize the request based on the source group identity
- call the host-side AH5 wrapper
- write the response file back to that group's AH5 response directory

Suggested new dependency added to `IpcDeps`:

```ts
agenthifiveExecute?: (params: {
  sourceGroup: string;
  chatJid: string;
  groupFolder: string;
  payload: {
    connectionId?: string;
    service?: string;
    method: string;
    url: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: unknown;
  };
}) => Promise<unknown>;
```

Suggested processing branch:

- `processAgentHiFiveIpc(...)`

Responsibilities of that branch:

- parse request
- validate required fields
- call `deps.agenthifiveExecute(...)`
- write `{ requestId, ok, result }` or `{ requestId, ok: false, error }`

This keeps `src/ipc.ts` responsible only for transport/orchestration, not AH5 business logic.

### 3. `src/agenthifive-nanoclaw/ipc-mcp-wrapper.ts`

This should be the host-side entrypoint for AH5-backed tool execution.

Responsibilities:

- receive normalized execution requests from `src/ipc.ts`
- call `vault-client.ts`
- detect `approvalRequired`
- register pending approvals with full replay payload
- return the immediate result or approval-required response to the container bridge

Suggested interface:

```ts
export type AgentHiFiveExecuteParams = {
  sourceGroup: string;
  chatJid: string;
  groupFolder: string;
  payload: {
    connectionId?: string;
    service?: string;
    method: string;
    url: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: unknown;
  };
};

export interface AgentHiFiveIpcMcpWrapper {
  execute(params: AgentHiFiveExecuteParams): Promise<unknown>;
}
```

For approval-required responses, this wrapper should persist:

```ts
{
  approvalRequestId: string,
  routing: {
    sourceGroup: string,
    chatJid: string,
    groupFolder: string
  },
  originalPayload: {
    model: "B",
    connectionId?: string,
    service?: string,
    method: string,
    url: string,
    query?: Record<string, string>,
    headers?: Record<string, string>,
    body?: unknown
  },
  createdAt: string
}
```

### 4. `src/agenthifive-nanoclaw/vault-client.ts`

Keep this very small for the spike.

Responsibilities:

- `execute(...)`
- `pollApproval(...)`
- `executeReplay(...)`

Suggested methods:

```ts
execute(payload): Promise<ExecuteResult>
pollApproval(approvalRequestId: string): Promise<{ status: string }>
executeReplay(originalPayload, approvalId: string): Promise<ReplayResult>
```

Keep auth simple for the spike:

- start with bearer token from env
- defer JWT auto-refresh until after the spike proves the model

### 5. `src/agenthifive-nanoclaw/pending-store.ts`

Use a single JSON file for the spike.

Suggested file location:

- `data/agenthifive/pending-approvals.json`

Responsibilities:

- load all pending approvals
- add one
- remove one
- overwrite atomically

Keep it intentionally simple and restart-safe.

### 6. `src/agenthifive-nanoclaw/approval-poller.ts`

Responsibilities:

- poll all pending approvals every 5 seconds
- on `approved`, replay exact payload with `approvalId`
- on `denied` or `expired`, trigger reinjection
- remove resolved approvals from the store

Suggested callback shape:

```ts
onResolved(result: {
  approvalRequestId: string;
  status: "approved" | "denied" | "expired";
  executionResult?: unknown;
  error?: string;
}, pending: PendingApproval): Promise<void>
```

### 7. `src/agenthifive-nanoclaw/result-injector.ts`

This should reinject approval outcomes into the original conversation via the existing host-side IPC/input flow used by the running container.

Most likely mechanism:

- write a synthetic input file into the target group's IPC input directory

Why:

- `container/agent-runner/src/index.ts` already polls `/workspace/ipc/input`
- that gives us a known path for delivering a follow-up message into the active session

Suggested injected message style for the spike:

```text
[AgentHiFive] Your request was approved and executed successfully.
Request: GET /v1/models
Response: ...
```

or

```text
[AgentHiFive] Your request was denied by the workspace owner.
Request: POST /...
```

This is intentionally similar to the nanobot spike: synthetic turn first, UX polish later.

### 8. `src/index.ts`

Add top-level adapter lifecycle wiring.

Responsibilities:

- initialize `AgentHiFiveAdapter` if env/config is present
- pass `agenthifiveExecute` into `startIpcWatcher(...)`
- stop the poller during shutdown

Suggested pseudo-wiring:

```ts
const ah5Adapter = maybeCreateAgentHiFiveAdapter();

startIpcWatcher({
  ...existingDeps,
  agenthifiveExecute: ah5Adapter
    ? (params) => ah5Adapter.execute(params)
    : undefined,
});

process.on("SIGTERM", async () => {
  await ah5Adapter?.stop();
});
```

### 9. `src/container-runner.ts`

No primary logic changes expected for Phase 1, but this file is the reference point for:

- the OneCLI seam
- the mounted `/workspace/ipc` directories
- the group-scoped container boundary

Only touch this file if the new AH5 IPC directories need to be explicitly created alongside:

- `messages/`
- `tasks/`
- `input/`

If needed, add:

- `agenthifive-requests/`
- `agenthifive-responses/`

### 10. `container/agent-runner/src/index.ts`

Ideally no functional changes for the spike.

This file already:

- registers the `nanoclaw` MCP server
- points it at `ipc-mcp-stdio.js`
- polls `/workspace/ipc/input` for follow-up messages

That means reinjection should work without any major change if we use the same input-file path.

## Minimal Spike Message Types

To keep the spike simple, add only two new host/container IPC message families:

### AH5 request

```ts
type AgentHiFiveRequest = {
  type: "agenthifive_execute";
  requestId: string;
  chatJid: string;
  groupFolder: string;
  timestamp: string;
  payload: {
    connectionId?: string;
    service?: string;
    method: string;
    url: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: unknown;
  };
};
```

### AH5 response

```ts
type AgentHiFiveResponse = {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};
```

No other new IPC protocol should be introduced unless the spike proves it is necessary.

## First End-to-End Demo Target

The first complete demo should be:

1. user asks the agent to perform one AH5-backed read action
2. tool request travels container -> IPC -> host -> AH5
3. result returns host -> IPC -> container -> agent
4. user sees the answer normally

Then the approval demo:

1. user asks for one approval-gated AH5-backed action
2. host wrapper receives `approvalRequired`
3. pending approval is stored
4. approval is granted in AH5
5. host poller replays exact payload
6. result is written into the group's IPC input path
7. running agent picks it up as a follow-up turn and responds naturally

## Things To Avoid In The First Patch

- do not add JWT refresh yet
- do not add more than one or two AH5-backed tools
- do not add LLM routing logic
- do not add channel-specific logic
- do not try to generalize this into a pluggable host transport framework

The first patch should only prove the transport, replay, and reinjection model.

## What To Test First

### Test 1: Basic AH5-backed tool execution

Prove a NanoClaw tool can call AgentHiFive and return real provider data.

### Test 2: Approval tracking

Prove the host-side adapter can detect `approvalRequired`, capture original payload, and persist it.

### Test 3: Replay after approval

Prove the poller can replay the exact stored payload and get a successful result.

### Test 4: Delivery back into conversation

Prove the result can be injected back into the correct user conversation through IPC with acceptable UX.

### Test 5: Restart resilience

Prove pending approvals survive process restart.

### Test 6: Tamper rejection

Prove fingerprint validation rejects modified payloads.

## Open Questions The Spike Must Answer

1. What is the cleanest place in NanoClaw's host-side IPC/MCP bridge to observe AH5-backed tool requests and results?
2. What is the cleanest way to identify the originating group/session across the host/container boundary?
3. What is the cleanest IPC reinjection mechanism for synthetic approval-result messages?
4. Can the adapter remain host-side and self-contained, or does NanoClaw need a new transport abstraction?
5. How much of the existing host-side credential plumbing can be reused later for Phase 2?

## Recommendation On OpenCLI / OneCLI

Do not make OpenCLI/OneCLI the center of the spike.

It may become a useful seam later, especially for transport or credential delivery, but the spike should optimize for validating AgentHiFive's stronger security semantics:

- policy-governed execution
- approval-bound exact replay
- auditability
- clear result reinjection

Credential injection alone is not enough to validate the integration model.

Known seam to revisit later:

- NanoClaw's host-side credential/container setup already has OneCLI integration points for agent provisioning and container arg mutation

Those should be treated as **known, parked surfaces for Phase 2**, not as the primary focus of the data/tool spike.

## What We Already Know From The nanobot Spike

The nanobot spike already validated the core AH5 model:

- MCP-based AH5 tool integration works without changes to `agenthifive-mcp`
- adapter-owned approval tracking works
- adapter-owned exact replay works
- fingerprint validation blocks tampered replays
- reinjection of approval outcomes back into the conversation is viable

What NanoClaw changes is not the core security model, but the transport and reinjection shape:

- nanobot was in-process
- NanoClaw is host-side orchestration plus a containerized agent runtime

So the NanoClaw spike is primarily about validating:

- host-side interception
- host-side replay ownership
- IPC-based result delivery
- correct routing across the group/session boundary

## Phase Plan After Spike

### Phase 1

If the spike succeeds:

- harden the AH5-backed data/tool adapter
- improve reinjection UX
- add JWT-based agent auth and auto-refresh
- expand to a few more protected external actions

### Phase 2

Only then evaluate AH5-backed LLM routing.

This should be treated as a separate problem because it likely requires:

- per-request session metadata
- approval-aware request handling
- handling non-standard approval-gate responses

Phase 2 should also revisit NanoClaw's known OneCLI surfaces for credential and transport integration.

### Phase 3

Channels last, and only if justified by product need.

## Deliverables

The spike should produce:

- a small working `agenthifive-nanoclaw` adapter
- one end-to-end demo flow
- one restart-resilience demo
- one tamper-rejection test
- a short write-up of:
  - what worked
  - what required NanoClaw changes
  - what remains for data/tools
  - whether LLM routing looks feasible

## Bottom Line

Start with the smallest possible AH5-backed data/tool spike.

Keep AgentHiFive-specific logic in a dedicated adapter.
Use NanoClaw's verified IPC/MCP bridge rather than inventing a new transport.
Keep NanoClaw changes narrow and local.
Do not tackle LLMs or channels until the approval replay and reinjection model is proven.
