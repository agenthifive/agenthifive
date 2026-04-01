import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isGmailAttachmentUrl,
  isOutlookAttachmentUrl,
  extractGmailAttachmentIds,
  extractOutlookAttachmentIds,
} from "../../utils/attachment-metadata.js";

describe("attachment-metadata URL detection", () => {
  // ── Gmail ──

  it("detects Gmail attachment URLs", () => {
    assert.equal(isGmailAttachmentUrl("https://www.googleapis.com/gmail/v1/users/me/messages/abc123/attachments/def456"), true);
    assert.equal(isGmailAttachmentUrl("https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123/attachments/def456"), true);
  });

  it("rejects non-attachment Gmail URLs", () => {
    assert.equal(isGmailAttachmentUrl("https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123"), false);
    assert.equal(isGmailAttachmentUrl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send"), false);
    assert.equal(isGmailAttachmentUrl("https://gmail.googleapis.com/gmail/v1/users/me/labels"), false);
  });

  it("extracts Gmail message and attachment IDs", () => {
    const result = extractGmailAttachmentIds("https://www.googleapis.com/gmail/v1/users/me/messages/msg123/attachments/att456");
    assert.deepEqual(result, { messageId: "msg123", attachmentId: "att456" });
  });

  it("extracts Gmail IDs with query params", () => {
    const result = extractGmailAttachmentIds("https://www.googleapis.com/gmail/v1/users/me/messages/msg123/attachments/att456?alt=json");
    assert.deepEqual(result, { messageId: "msg123", attachmentId: "att456" });
  });

  it("returns null for non-attachment Gmail URLs", () => {
    assert.equal(extractGmailAttachmentIds("https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123"), null);
  });

  // ── Outlook ──

  it("detects Outlook attachment URLs", () => {
    assert.equal(isOutlookAttachmentUrl("https://graph.microsoft.com/v1.0/me/messages/AAMkAGI2T/attachments/AAMkADE"), true);
  });

  it("rejects non-Graph URLs that match path pattern", () => {
    assert.equal(isOutlookAttachmentUrl("https://evil.example.com/v1.0/me/messages/id/attachments/id"), false);
  });

  it("rejects non-attachment Outlook URLs", () => {
    assert.equal(isOutlookAttachmentUrl("https://graph.microsoft.com/v1.0/me/messages/AAMkAGI2T"), false);
    assert.equal(isOutlookAttachmentUrl("https://graph.microsoft.com/v1.0/me/contacts/abc"), false);
  });

  it("extracts Outlook message and attachment IDs", () => {
    const result = extractOutlookAttachmentIds("https://graph.microsoft.com/v1.0/me/messages/AAMkAGI2T/attachments/AAMkADE");
    assert.deepEqual(result, { messageId: "AAMkAGI2T", attachmentId: "AAMkADE" });
  });

  it("returns null for non-attachment Outlook URLs", () => {
    assert.equal(extractOutlookAttachmentIds("https://graph.microsoft.com/v1.0/me/messages/AAMkAGI2T"), null);
  });

  // ── Edge cases ──

  it("handles invalid URLs gracefully", () => {
    assert.equal(isGmailAttachmentUrl("not-a-url"), false);
    assert.equal(isOutlookAttachmentUrl("not-a-url"), false);
    assert.equal(extractGmailAttachmentIds("not-a-url"), null);
    assert.equal(extractOutlookAttachmentIds("not-a-url"), null);
  });
});
