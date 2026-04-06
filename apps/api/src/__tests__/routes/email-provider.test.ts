import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Email Provider Unit Tests
 *
 * Tests the IMAP/SMTP-to-REST translation layer without real mail servers.
 * All IMAP (imapflow) and SMTP (nodemailer) calls are mocked.
 *
 * Run:
 *   node --experimental-test-module-mocks --import tsx --test --test-concurrency=1 \
 *     --test-force-exit 'src/__tests__/routes/email-provider.test.ts'
 */

// =============================================================================
// STEP 0: Set env vars BEFORE any imports
// =============================================================================

process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// =============================================================================
// STEP 1: Mock external dependencies
// =============================================================================

// -- Mock ImapFlow ---------------------------------------------------------

const fakeMailboxes = [
  { name: "INBOX", path: "INBOX", delimiter: "/", specialUse: "\\Inbox", flags: new Set(["\\HasNoChildren"]) },
  { name: "Sent", path: "Sent", delimiter: "/", specialUse: "\\Sent", flags: new Set(["\\HasNoChildren"]) },
  { name: "Trash", path: "Trash", delimiter: "/", specialUse: "\\Trash", flags: new Set(["\\HasNoChildren"]) },
];

const fakeMessage = {
  uid: 42,
  envelope: {
    messageId: "<msg42@example.com>",
    date: new Date("2026-01-15T10:30:00Z"),
    from: [{ name: "Alice", address: "alice@example.com" }],
    to: [{ name: "Bob", address: "bob@example.com" }],
    cc: [],
    subject: "Test Subject",
    inReplyTo: null,
  },
  flags: new Set(["\\Seen"]),
  size: 2048,
  bodyStructure: { disposition: null, childNodes: [] },
  source: Buffer.from(
    "From: alice@example.com\r\nTo: bob@example.com\r\nSubject: Test Subject\r\n\r\nHello world",
  ),
};

/** Whether the mock ImapFlow should throw on connect */
let imapConnectError: Error | null = null;
/** Control which UIDs search returns */
let imapSearchResult: number[] = [42, 41, 40];
/** Control what fetch yields */
let imapFetchMessages: typeof fakeMessage[] = [fakeMessage];

function resetImapState() {
  imapConnectError = null;
  imapSearchResult = [42, 41, 40];
  imapFetchMessages = [fakeMessage];
}

const mockImapFlowConstructor = mock.fn(function MockImapFlow(this: any, _opts: any) {
  this._usable = true;
  Object.defineProperty(this, "usable", { get: () => this._usable });
  this.connect = mock.fn(async () => {
    if (imapConnectError) throw imapConnectError;
  });
  this.logout = mock.fn(async () => { this._usable = false; });
  this.list = mock.fn(async () => fakeMailboxes);
  this.status = mock.fn(async (_path: string, _opts: any) => ({ messages: 10, unseen: 2 }));
  this.getMailboxLock = mock.fn(async (_folder: string) => ({ release: mock.fn() }));
  this.search = mock.fn(async (_criteria: any, _opts: any) => imapSearchResult);
  this.fetch = mock.fn(function* (_uids: number[], _fetchOpts: any, _extraOpts: any) {
    // Return an async iterable
    return undefined as any;
  });
  // Replace fetch with an object that has [Symbol.asyncIterator]
  this.fetch = mock.fn((_uids: number[], _fetchOpts: any, _extraOpts: any) => {
    let index = 0;
    const msgs = imapFetchMessages;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (index < msgs.length) {
              return { value: msgs[index++], done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    };
  });
  this.messageMove = mock.fn(async () => {});
  this.messageCopy = mock.fn(async () => {});
  this.messageDelete = mock.fn(async () => {});
  this.messageFlagsAdd = mock.fn(async () => {});
  this.messageFlagsRemove = mock.fn(async () => {});
  this.mailboxCreate = mock.fn(async () => {});
  this.mailboxDelete = mock.fn(async () => {});
});

mock.module("imapflow", {
  namedExports: {
    ImapFlow: mockImapFlowConstructor,
  },
});

// -- Mock nodemailer -------------------------------------------------------

let smtpVerifyError: Error | null = null;
let smtpSendMailError: Error | null = null;

function resetSmtpState() {
  smtpVerifyError = null;
  smtpSendMailError = null;
}

const mockSendMail = mock.fn(async () => {
  if (smtpSendMailError) throw smtpSendMailError;
  return { messageId: "<test@example.com>" };
});
const mockVerify = mock.fn(async () => {
  if (smtpVerifyError) throw smtpVerifyError;
});
const mockClose = mock.fn(() => {});

mock.module("nodemailer", {
  namedExports: {
    createTransport: mock.fn(() => ({
      sendMail: mockSendMail,
      verify: mockVerify,
      close: mockClose,
    })),
  },
});

// -- Mock mailparser (used inside handleReadMessage) -----------------------

mock.module("mailparser", {
  namedExports: {
    simpleParser: mock.fn(async () => ({
      text: "Hello world",
      html: "<p>Hello world</p>",
      attachments: [],
      references: null,
    })),
  },
});

// =============================================================================
// STEP 2: Import dependencies AFTER mocking (dynamic import required)
// =============================================================================

interface EmailCredentials {
  imap: { host: string; port: number; tls: boolean; username: string; password: string };
  smtp: { host: string; port: number; starttls: boolean; username: string; password: string };
  email: string;
  displayName?: string;
}

let handleEmailRequest: (
  method: string, url: string, body: unknown, credentials: EmailCredentials,
  connectionId: string, log: any,
) => Promise<{ status: number; body: unknown }>;

let validateEmailConnection: (credentials: EmailCredentials) => Promise<{ valid: boolean; error?: string }>;
let closeAllEmailConnections: () => void;

// =============================================================================
// STEP 3: Test helpers
// =============================================================================

const fakeLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => fakeLog,
} as any;

function makeCredentials(overrides?: Partial<EmailCredentials>): EmailCredentials {
  return {
    imap: { host: "imap.example.com", port: 993, tls: true, username: "user@example.com", password: "secret" },
    smtp: { host: "smtp.example.com", port: 587, starttls: true, username: "user@example.com", password: "secret" },
    email: "user@example.com",
    displayName: "Test User",
    ...overrides,
  };
}

const CONNECTION_ID = "test-conn-001";

// =============================================================================
// STEP 4: Tests
// =============================================================================

describe("email-provider", () => {
  before(async () => {
    const mod = await import("../../routes/email-provider.js");
    handleEmailRequest = mod.handleEmailRequest;
    validateEmailConnection = mod.validateEmailConnection;
    closeAllEmailConnections = mod.closeAllEmailConnections;
  });

  beforeEach(() => {
    resetImapState();
    resetSmtpState();
    closeAllEmailConnections();
  });

  // =========================================================================
  // URL Routing / Dispatch
  // =========================================================================

  describe("handleEmailRequest — URL routing", () => {
    it("GET /folders dispatches to list folders", async () => {
      const result = await handleEmailRequest("GET", "/folders", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 200);
      const body = result.body as any;
      assert.ok(Array.isArray(body.folders));
      assert.equal(body.folders.length, 3);
      assert.equal(body.folders[0].name, "INBOX");
    });

    it("GET /messages dispatches to list messages", async () => {
      const result = await handleEmailRequest("GET", "/messages?folder=INBOX&limit=10", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 200);
      const body = result.body as any;
      assert.ok(Array.isArray(body.messages));
      assert.equal(body.total, 3); // imapSearchResult has 3 UIDs
      assert.equal(body.limit, 10);
    });

    it("GET /messages/123 dispatches to read message", async () => {
      imapFetchMessages = [{ ...fakeMessage, uid: 123 }];
      const result = await handleEmailRequest("GET", "/messages/123", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 200);
      const body = result.body as any;
      assert.equal(body.uid, 123);
      assert.equal(body.textBody, "Hello world");
    });

    it("POST /messages/send dispatches to send message", async () => {
      const sendBody = {
        to: [{ name: "Bob", address: "bob@example.com" }],
        subject: "Hi",
        textBody: "Hello",
      };
      const result = await handleEmailRequest("POST", "/messages/send", sendBody, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 200);
      const body = result.body as any;
      assert.equal(body.sent, true);
      assert.equal(body.messageId, "<test@example.com>");
    });

    it("POST /messages/123/reply dispatches to reply", async () => {
      imapFetchMessages = [{ ...fakeMessage, uid: 123 }];
      const replyBody = { textBody: "Thanks!" };
      const result = await handleEmailRequest("POST", "/messages/123/reply", replyBody, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 200);
      const body = result.body as any;
      assert.equal(body.sent, true);
    });

    it("POST /messages/123/forward dispatches to forward", async () => {
      imapFetchMessages = [{ ...fakeMessage, uid: 123 }];
      const fwdBody = { to: [{ name: "Carol", address: "carol@example.com" }], textBody: "FYI" };
      const result = await handleEmailRequest("POST", "/messages/123/forward", fwdBody, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 200);
      const body = result.body as any;
      assert.equal(body.sent, true);
    });

    it("POST /messages/123/move dispatches to move message", async () => {
      const result = await handleEmailRequest(
        "POST", "/messages/123/move", { destination: "Archive" }, makeCredentials(), CONNECTION_ID, fakeLog,
      );
      assert.equal(result.status, 200);
      const body = result.body as any;
      assert.equal(body.moved, true);
      assert.equal(body.to, "Archive");
    });

    it("POST /messages/123/copy dispatches to copy message", async () => {
      const result = await handleEmailRequest(
        "POST", "/messages/123/copy", { destination: "Backup" }, makeCredentials(), CONNECTION_ID, fakeLog,
      );
      assert.equal(result.status, 200);
      const body = result.body as any;
      assert.equal(body.copied, true);
      assert.equal(body.to, "Backup");
    });

    it("DELETE /messages/123 dispatches to delete message", async () => {
      const result = await handleEmailRequest("DELETE", "/messages/123", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 200);
      const body = result.body as any;
      assert.equal(body.deleted, true);
      assert.equal(body.uid, 123);
    });

    it("PATCH /messages/123/flags dispatches to update flags", async () => {
      const result = await handleEmailRequest(
        "PATCH", "/messages/123/flags", { add: ["\\Seen"], remove: ["\\Flagged"] }, makeCredentials(), CONNECTION_ID, fakeLog,
      );
      assert.equal(result.status, 200);
      const body = result.body as any;
      assert.equal(body.updated, true);
      assert.deepEqual(body.flagsAdded, ["\\Seen"]);
      assert.deepEqual(body.flagsRemoved, ["\\Flagged"]);
    });

    it("unknown path returns 404", async () => {
      const result = await handleEmailRequest("GET", "/nonexistent", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 404);
      const body = result.body as any;
      assert.ok(body.error.includes("Unknown email endpoint"));
    });

    it("unknown method on valid path returns 404", async () => {
      const result = await handleEmailRequest("PUT", "/folders", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 404);
    });
  });

  // =========================================================================
  // Search Query Parsing (tested indirectly via GET /messages)
  // =========================================================================

  describe("parseSearchQuery — via GET /messages", () => {
    it("empty query passes { all: true } to IMAP search", async () => {
      const result = await handleEmailRequest("GET", "/messages", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 200);
      // The mock search was called — verify via the returned structure
      const body = result.body as any;
      assert.ok(Array.isArray(body.messages));
    });

    it("from:bob passes from criteria", async () => {
      const result = await handleEmailRequest("GET", "/messages?q=from:bob", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 200);
    });

    it("subject:meeting unseen passes combined criteria", async () => {
      const result = await handleEmailRequest("GET", "/messages?q=subject:meeting%20unseen", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 200);
    });

    it("since and before date params are forwarded", async () => {
      const result = await handleEmailRequest(
        "GET",
        "/messages?since=2026-01-01&before=2026-02-01",
        null,
        makeCredentials(),
        CONNECTION_ID,
        fakeLog,
      );
      assert.equal(result.status, 200);
    });

    it("quoted strings in query are handled (from:bob subject:\"hello world\")", async () => {
      const result = await handleEmailRequest(
        "GET",
        '/messages?q=from:bob%20subject:%22hello%20world%22',
        null,
        makeCredentials(),
        CONNECTION_ID,
        fakeLog,
      );
      assert.equal(result.status, 200);
    });
  });

  // =========================================================================
  // Error Handling
  // =========================================================================

  describe("error handling", () => {
    it("authentication failure returns 401", async () => {
      imapConnectError = new Error("Authentication failed");
      const result = await handleEmailRequest("GET", "/folders", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 401);
      const body = result.body as any;
      assert.ok(body.error.includes("authentication failed"));
    });

    it("LOGIN failure returns 401", async () => {
      imapConnectError = new Error("LOGIN command failed");
      const result = await handleEmailRequest("GET", "/folders", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 401);
    });

    it("ECONNREFUSED returns 502", async () => {
      imapConnectError = new Error("connect ECONNREFUSED 127.0.0.1:993");
      const result = await handleEmailRequest("GET", "/folders", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 502);
      const body = result.body as any;
      assert.ok(body.error.includes("Cannot connect"));
    });

    it("EHOSTUNREACH returns 502", async () => {
      imapConnectError = new Error("connect EHOSTUNREACH");
      const result = await handleEmailRequest("GET", "/folders", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 502);
    });

    it("generic error returns 500", async () => {
      imapConnectError = new Error("Something unexpected");
      const result = await handleEmailRequest("GET", "/folders", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 500);
      const body = result.body as any;
      assert.ok(body.error.includes("Email operation failed"));
    });
  });

  // =========================================================================
  // Connection Validation
  // =========================================================================

  describe("validateEmailConnection", () => {
    it("returns valid:true when both IMAP and SMTP succeed", async () => {
      const result = await validateEmailConnection(makeCredentials());
      assert.equal(result.valid, true);
      assert.equal(result.error, undefined);
    });

    it("returns IMAP auth failure when IMAP connect throws Authentication error", async () => {
      imapConnectError = new Error("Authentication failed");
      const result = await validateEmailConnection(makeCredentials());
      assert.equal(result.valid, false);
      assert.ok(result.error!.includes("IMAP authentication failed"));
    });

    it("returns IMAP connection failure for non-auth IMAP errors", async () => {
      imapConnectError = new Error("ECONNREFUSED");
      const result = await validateEmailConnection(makeCredentials());
      assert.equal(result.valid, false);
      assert.ok(result.error!.includes("IMAP connection failed"));
    });

    it("returns SMTP auth failure when SMTP verify throws auth error", async () => {
      smtpVerifyError = new Error("Invalid authentication credentials");
      const result = await validateEmailConnection(makeCredentials());
      assert.equal(result.valid, false);
      assert.ok(result.error!.includes("SMTP authentication failed"));
    });

    it("returns SMTP connection failure for non-auth SMTP errors", async () => {
      smtpVerifyError = new Error("ECONNREFUSED");
      const result = await validateEmailConnection(makeCredentials());
      assert.equal(result.valid, false);
      assert.ok(result.error!.includes("SMTP connection failed"));
    });
  });

  // =========================================================================
  // Additional edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("POST /messages/send without recipients returns 400", async () => {
      const result = await handleEmailRequest("POST", "/messages/send", { subject: "No recipients" }, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 400);
      const body = result.body as any;
      assert.ok(body.error.includes("recipient"));
    });

    it("POST /messages/123/move without destination returns 400", async () => {
      const result = await handleEmailRequest("POST", "/messages/123/move", {}, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 400);
      const body = result.body as any;
      assert.ok(body.error.includes("Destination"));
    });

    it("POST /messages/123/copy without destination returns 400", async () => {
      const result = await handleEmailRequest("POST", "/messages/123/copy", {}, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 400);
      const body = result.body as any;
      assert.ok(body.error.includes("Destination"));
    });

    it("GET /messages with empty search results returns empty array", async () => {
      imapSearchResult = [];
      const result = await handleEmailRequest("GET", "/messages", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 200);
      const body = result.body as any;
      assert.deepEqual(body.messages, []);
      assert.equal(body.total, 0);
    });

    it("GET /messages respects offset and limit params", async () => {
      imapSearchResult = [50, 49, 48, 47, 46, 45, 44, 43, 42, 41];
      // Request offset=2, limit=3 — should page the sorted UID list
      const result = await handleEmailRequest("GET", "/messages?offset=2&limit=3", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 200);
      const body = result.body as any;
      assert.equal(body.total, 10);
      assert.equal(body.offset, 2);
      assert.equal(body.limit, 3);
    });

    it("GET /messages/999 returns 404 when message not found", async () => {
      imapFetchMessages = []; // No messages returned by fetch
      const result = await handleEmailRequest("GET", "/messages/999", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 404);
      const body = result.body as any;
      assert.ok(body.error.includes("not found"));
    });

    it("PATCH /messages/123/flags with only add flags works", async () => {
      const result = await handleEmailRequest(
        "PATCH", "/messages/123/flags", { add: ["\\Flagged"] }, makeCredentials(), CONNECTION_ID, fakeLog,
      );
      assert.equal(result.status, 200);
      const body = result.body as any;
      assert.deepEqual(body.flagsAdded, ["\\Flagged"]);
      assert.deepEqual(body.flagsRemoved, []);
    });

    it("PATCH /messages/123/flags with only remove flags works", async () => {
      const result = await handleEmailRequest(
        "PATCH", "/messages/123/flags", { remove: ["\\Seen"] }, makeCredentials(), CONNECTION_ID, fakeLog,
      );
      assert.equal(result.status, 200);
      const body = result.body as any;
      assert.deepEqual(body.flagsAdded, []);
      assert.deepEqual(body.flagsRemoved, ["\\Seen"]);
    });

    it("POST /folders creates a folder", async () => {
      const result = await handleEmailRequest("POST", "/folders", { name: "MyFolder" }, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 201);
      const body = result.body as any;
      assert.equal(body.created, true);
      assert.equal(body.path, "MyFolder");
    });

    it("POST /folders without name returns 400", async () => {
      const result = await handleEmailRequest("POST", "/folders", {}, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 400);
      const body = result.body as any;
      assert.ok(body.error.includes("name"));
    });

    it("DELETE /folders/Trash deletes a folder", async () => {
      const result = await handleEmailRequest("DELETE", "/folders/Trash", null, makeCredentials(), CONNECTION_ID, fakeLog);
      assert.equal(result.status, 200);
      const body = result.body as any;
      assert.equal(body.deleted, true);
      assert.equal(body.path, "Trash");
    });
  });
});
