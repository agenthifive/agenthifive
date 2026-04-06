import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

process.env["SENTRY_DSN"] = "https://public@example.ingest.sentry.io/123";

const callOrder: string[] = [];
const captureException = mock.fn((_error: unknown, _context?: unknown) => {
  callOrder.push("capture");
});
const flush = mock.fn(async (_timeout?: number) => {
  callOrder.push("flush");
});
const fastifyIntegration = mock.fn(() => ({ name: "fastify" }));
const init = mock.fn(() => {});
const setupFastifyErrorHandler = mock.fn(() => {});

mock.module("@sentry/node", {
  namedExports: {
    captureException,
    fastifyIntegration,
    flush,
    init,
    setupFastifyErrorHandler,
  },
});

const instrument = await import("../../instrument.ts");

describe("Sentry fatal instrumentation", () => {
  beforeEach(() => {
    callOrder.length = 0;
    captureException.mock.resetCalls();
    flush.mock.resetCalls();
    instrument.resetFatalHandlerStateForTests();
  });

  it("captures, flushes, and exits for unhandled rejections", async () => {
    const exitError = new Error("process.exit called");
    const exitMock = mock.method(process, "exit", ((code?: number) => {
      callOrder.push(`exit:${code ?? 0}`);
      throw exitError;
    }) as typeof process.exit);

    await assert.rejects(
      instrument.handleProcessFatalError("unhandledRejection", "boom"),
      exitError,
    );

    assert.equal(captureException.mock.callCount(), 1);
    assert.equal(flush.mock.callCount(), 1);
    assert.deepEqual(callOrder, ["capture", "flush", "exit:1"]);

    const [capturedError, context] = captureException.mock.calls[0]!.arguments as [Error, { tags: { source: string } }];
    assert.equal(capturedError.message, "boom");
    assert.equal(context.tags.source, "unhandledRejection");

    exitMock.mock.restore();
  });
});
