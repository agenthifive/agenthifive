import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initPendingApprovals,
  addPendingApproval,
  loadPendingApprovals,
  savePendingApprovals,
} from "../../dist/pending-approvals.js";

describe("pending-approvals", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ah5-pending-approvals-"));
    initPendingApprovals(stateDir, {
      info: () => {},
      warn: () => {},
      error: () => {},
    });
    savePendingApprovals([]);
  });

  describe("loadPendingApprovals", () => {
    it("returns empty array initially", () => {
      const result = loadPendingApprovals();
      assert.deepEqual(result, []);
    });
  });

  describe("savePendingApprovals", () => {
    it("saves and loads approvals", () => {
      const approvals = [
        {
          approvalRequestId: "apr_001",
          method: "POST",
          url: "https://api.example.com/send",
          summary: "Send email to user@example.com",
          createdAt: "2026-03-18T10:00:00Z",
        },
      ];

      savePendingApprovals(approvals);
      const loaded = loadPendingApprovals();

      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]!.approvalRequestId, "apr_001");
      assert.equal(loaded[0]!.summary, "Send email to user@example.com");
    });

    it("overwrites previous approvals", () => {
      savePendingApprovals([
        { approvalRequestId: "apr_001", method: "GET", url: "/a", summary: "First", createdAt: "2026-03-18T10:00:00Z" },
      ]);
      savePendingApprovals([
        { approvalRequestId: "apr_002", method: "POST", url: "/b", summary: "Second", createdAt: "2026-03-18T11:00:00Z" },
      ]);

      const loaded = loadPendingApprovals();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]!.approvalRequestId, "apr_002");
    });

    it("reloads persisted approvals after re-initialization", () => {
      savePendingApprovals([
        { approvalRequestId: "apr_disk", method: "POST", url: "/disk", summary: "Disk", createdAt: "2026-03-18T11:00:00Z" },
      ]);

      initPendingApprovals(stateDir, {
        info: () => {},
        warn: () => {},
        error: () => {},
      });

      const loaded = loadPendingApprovals();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]!.approvalRequestId, "apr_disk");
    });
  });

  describe("addPendingApproval", () => {
    it("adds a new approval", () => {
      addPendingApproval({
        approvalRequestId: "apr_100",
        method: "DELETE",
        url: "https://api.example.com/resource/123",
        summary: "Delete resource 123",
        createdAt: "2026-03-18T12:00:00Z",
      });

      const loaded = loadPendingApprovals();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]!.approvalRequestId, "apr_100");
    });

    it("deduplicates by approvalRequestId", () => {
      const approval = {
        approvalRequestId: "apr_dup",
        method: "POST",
        url: "https://api.example.com/send",
        summary: "Send message",
        createdAt: "2026-03-18T12:00:00Z",
      };

      addPendingApproval(approval);
      addPendingApproval(approval);

      const loaded = loadPendingApprovals();
      assert.equal(loaded.length, 1);
    });

    it("preserves existing approvals when adding new one", () => {
      addPendingApproval({
        approvalRequestId: "apr_first",
        method: "GET",
        url: "/first",
        summary: "First",
        createdAt: "2026-03-18T10:00:00Z",
      });
      addPendingApproval({
        approvalRequestId: "apr_second",
        method: "POST",
        url: "/second",
        summary: "Second",
        createdAt: "2026-03-18T11:00:00Z",
      });

      const loaded = loadPendingApprovals();
      assert.equal(loaded.length, 2);
      assert.equal(loaded[0]!.approvalRequestId, "apr_first");
      assert.equal(loaded[1]!.approvalRequestId, "apr_second");
    });
  });
});
