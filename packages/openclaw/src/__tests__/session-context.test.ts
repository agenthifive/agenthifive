import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSessionKey,
  setCurrentSessionContext,
  getCurrentSessionContext,
} from "../../dist/session-context.js";

describe("session-context", () => {
  describe("parseSessionKey", () => {
    it("parses a 5-part session key (agent:id:channel:peerKind:peerId)", () => {
      const result = parseSessionKey("agent:ag_001:telegram:dm:user123");
      assert.equal(result.channel, "telegram");
      assert.equal(result.peerKind, "dm");
      assert.equal(result.peerId, "user123");
    });

    it("parses a 6-part session key (agent:id:channel:accountId:peerKind:peerId)", () => {
      const result = parseSessionKey("agent:ag_001:slack:acc_1:channel:C12345");
      assert.equal(result.channel, "slack");
      assert.equal(result.peerKind, "channel");
      assert.equal(result.peerId, "C12345");
    });

    it("parses a 6+ part key with colons in peerId", () => {
      const result = parseSessionKey("agent:ag_001:telegram:acc_1:group:chat:456");
      assert.equal(result.channel, "telegram");
      assert.equal(result.peerKind, "group");
      assert.equal(result.peerId, "chat:456");
    });

    it("returns empty object for keys with fewer than 5 parts", () => {
      const result = parseSessionKey("agent:ag_001:main");
      assert.equal(result.channel, undefined);
      assert.equal(result.peerId, undefined);
      assert.equal(result.peerKind, undefined);
    });

    it("returns empty object for empty string", () => {
      const result = parseSessionKey("");
      assert.equal(result.channel, undefined);
      assert.equal(result.peerId, undefined);
    });

    it("returns empty object for short key", () => {
      const result = parseSessionKey("agent:ag_001");
      assert.equal(result.channel, undefined);
    });
  });

  describe("get/setCurrentSessionContext", () => {
    it("stores and retrieves session context", () => {
      setCurrentSessionContext({
        sessionKey: "agent:ag_001:telegram:dm:user123",
        channel: "telegram",
        peerId: "user123",
        peerKind: "dm",
      });

      const ctx = getCurrentSessionContext();
      assert.ok(ctx);
      assert.equal(ctx.sessionKey, "agent:ag_001:telegram:dm:user123");
      assert.equal(ctx.channel, "telegram");
      assert.equal(ctx.peerId, "user123");
      assert.equal(ctx.peerKind, "dm");

      const runtimeState = (globalThis as Record<string, unknown>).__ah5_runtime as
        | { currentSessionKey?: string | null }
        | undefined;
      assert.equal(runtimeState?.currentSessionKey, "agent:ag_001:telegram:dm:user123");
    });

    it("overwrites previous context", () => {
      setCurrentSessionContext({ sessionKey: "agent:ag_001:main" });
      setCurrentSessionContext({ sessionKey: "agent:ag_002:slack:dm:U123" });
      const ctx = getCurrentSessionContext();
      assert.ok(ctx);
      assert.equal(ctx.sessionKey, "agent:ag_002:slack:dm:U123");
    });
  });
});
