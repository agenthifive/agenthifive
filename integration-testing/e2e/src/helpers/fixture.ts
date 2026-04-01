/**
 * E2E Shared Fixture
 *
 * After the setup phase (seed DB + bootstrap agent), the orchestrator writes
 * a JSON fixture file. Each test scenario reads it to get seed data and
 * agent credentials.
 */
import { readFileSync } from "node:fs";
import type { SeedResult } from "./seed-db.js";
import type { JWK } from "jose";

export interface E2EFixture {
  seed: SeedResult;
  creds: {
    agentId: string;
    workspaceId: string;
    accessToken: string;
    privateKey: JWK;
    publicKey: JWK;
  };
}

const FIXTURE_PATH = process.env["E2E_FIXTURE_PATH"] || "/tmp/e2e-fixture.json";

let _fixture: E2EFixture | null = null;

export function loadFixture(): E2EFixture {
  if (_fixture) return _fixture;
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  _fixture = JSON.parse(raw) as E2EFixture;
  return _fixture;
}
