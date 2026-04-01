---
title: Execution Models
sidebar_position: 5
sidebar_label: Execution Models
description: How AI agents interact with provider APIs -- Model A (token vending), Model B (brokered proxy), and Model C (sandbox).
---

# Execution Models

AgentHiFive supports multiple execution models that define how an AI agent accesses provider APIs. Each model represents a different trust level and policy enforcement strategy.

## Model A: Token Vending

The agent receives a time-limited provider token and calls the provider API directly.

```
Human           AgentHiFive              Agent              Provider API
  |                  |                     |                      |
  |-- approve ------>|                     |                      |
  |                  |-- vend token ------>|                      |
  |                  |   (scoped, short)   |                      |
  |                  |                     |-- direct API call -->|
  |                  |                     |<-- response ---------|
  |                  |                     |                      |
```

**How it works:**

1. The human approves a delegation request in the dashboard
2. AgentHiFive issues a scoped, time-limited provider token to the agent
3. The agent calls the provider API directly with that token
4. AgentHiFive has no visibility into individual API calls after the token is vended

**Characteristics:**

- Lowest latency -- no proxy hop
- Weakest policy enforcement -- policies are baked into the token scope at issuance time
- No per-request body inspection or response filtering
- Audit trail limited to token issuance and revocation events
- Best for trusted agents performing bulk read operations

## Model B: Brokered Proxy

The agent sends every request through AgentHiFive, which evaluates policy rules, decrypts the provider token, and forwards the request.

```
Agent            Nginx            AgentHiFive (Fastify)         Provider API
  |                |                      |                          |
  |-- request ---->|                      |                          |
  |  (Bearer JWT)  |-- sticky hash ------>|                          |
  |                |                      |-- policy eval (~0.1ms)   |
  |                |                      |-- decrypt token (~1ms)   |
  |                |                      |-- forward request ------>|
  |                |                      |   (50-500ms)             |
  |                |                      |<-- provider response ----|
  |                |                      |-- response filter        |
  |                |                      |-- async audit log        |
  |<-- response ---|<---------------------|                          |
```

**How it works:**

1. The agent sends an API request to AgentHiFive with a JWT
2. Nginx uses sticky sessions (header hash) to route to a consistent Fastify replica
3. The policy engine evaluates request rules (allow / deny / require_approval)
4. If allowed, AgentHiFive decrypts the provider token and forwards the request
5. Response rules filter the result (field stripping, PII redaction) before returning to the agent
6. An audit event is logged asynchronously

**Characteristics:**

- Full per-request policy enforcement (method, URL, body content)
- Response filtering and PII redaction (including real-time filtering on streams)
- Streaming support for SSE, NDJSON, and other content types via `stream: true`
- Complete audit trail of every API call
- Provider token never leaves AgentHiFive -- the agent only holds an AgentHiFive JWT
- Adds minimal overhead: policy check ~0.1ms, token decrypt ~1ms, provider call 50-500ms dominates
- Transparent LLM proxy route (`/v1/vault/llm/:provider/*`) lets AI SDKs use native HTTP calls through the vault

:::info Performance Strategy
Model B uses cookie-based sticky sessions and PostgreSQL LISTEN/NOTIFY instead of Redis. Each replica maintains an in-memory policy cache invalidated cross-replica via NOTIFY. JTI replay protection and rate limiting are database-backed. If a replica goes down, the load balancer re-routes to another which rebuilds its cache from PostgreSQL on first request (~5-10ms one-time cost).
:::

## Model C: Agent Runtime Sandbox (Future)

The agent runs inside a controlled sandbox environment managed by AgentHiFive.

```
Human           AgentHiFive              Sandbox              Provider API
  |                  |                     |                      |
  |-- configure ---->|                     |                      |
  |                  |-- spawn sandbox --->|                      |
  |                  |   (resource limits) |                      |
  |                  |                     |-- API call --------->|
  |                  |                     |<-- response ---------|
  |                  |<-- audit + result --|                      |
  |<-- notification -|                     |                      |
```

**How it works:**

1. The human configures a task and the sandbox environment
2. AgentHiFive spawns a sandboxed runtime with resource limits (CPU, memory, network, time)
3. The agent executes within the sandbox, with all API calls intercepted
4. Results and audit logs are returned to AgentHiFive when the task completes

**Characteristics:**

- Strongest isolation -- agent cannot escape the sandbox
- Resource limits prevent runaway costs
- Full audit trail plus execution logs
- Higher latency due to sandbox overhead
- Not in MVP scope -- planned for future phases

## Comparison

| Aspect | Model A (Token Vending) | Model B (Brokered Proxy) | Model C (Sandbox) |
|--------|------------------------|--------------------------|-------------------|
| **Trust level** | High -- agent is trusted | Medium -- verify then forward | Low -- fully contained |
| **Latency** | Lowest (direct call) | Low (+1-2ms proxy overhead) | Higher (sandbox overhead) |
| **Policy enforcement** | At token issuance only | Per-request (method + URL + body) | Per-request + resource limits |
| **Response filtering** | None | Field stripping + PII redaction (buffered and streaming) | Field stripping + PII redaction |
| **Audit granularity** | Token lifecycle events | Every API call | Every API call + execution logs |
| **Token exposure** | Agent holds provider token | Agent holds AgentHiFive JWT only | Token stays in sandbox |
| **Use case** | Trusted bulk reads | General-purpose agent access | Untrusted or high-risk tasks |
| **MVP status** | Yes | Yes | Future roadmap |

## Choosing a Model

- Use **Model A** when the agent is fully trusted and you need maximum throughput for read-heavy workloads (e.g., indexing a mailbox).

- Use **Model B** for the default case. It provides per-request policy enforcement, response filtering, and a complete audit trail with minimal overhead.

- Use **Model C** (when available) for untrusted agents or high-risk tasks where you need resource limits and full execution isolation.

Most deployments will use **Model B** as the default. Model A is available as an optimization for specific high-trust scenarios.
