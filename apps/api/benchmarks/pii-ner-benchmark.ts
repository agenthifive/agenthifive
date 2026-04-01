/**
 * PII NER Benchmark — Transformers.js on CPU
 *
 * Tests two models against realistic provider API payloads:
 *   1. piiranha-v1 (17 PII types, 6 languages — purpose-built for PII)
 *   2. bert-base-NER (person/location/org — general NER)
 *
 * Run:
 *   npx tsx apps/api/benchmarks/pii-ner-benchmark.ts
 *
 * Measures: cold start (model load), warm inference, throughput on CPU.
 */

import { pipeline, env, type TokenClassificationPipeline } from "@huggingface/transformers";

// Force CPU-only — no WebGPU, no CUDA
env.backends.onnx.wasm.numThreads = 1; // single-threaded to simulate worst case

// ── Test payloads (realistic Model B response bodies) ────────────────────────

const PAYLOADS = {
  gmailMessage: {
    label: "Gmail message (short)",
    text: `From: John Smith <john.smith@acme-corp.com>
To: Sarah Johnson <sarah.j@globex.net>
Subject: Invoice #INV-2024-8847

Hi Sarah,

Please find attached the invoice for the consulting services provided in January.
My phone number has changed — you can reach me at +1 (415) 555-0198 or my
direct line 212-867-5309.

For wire transfers, use IBAN DE89 3704 0044 0532 0130 00, account holder
John A. Smith, Deutsche Bank.

My SSN for the W-9 is 123-45-6789.
Credit card on file: 4532 0151 2345 6789 (exp 12/27).

Best regards,
John Smith
VP Engineering, Acme Corp
123 Market Street, San Francisco, CA 94105`,
  },

  gmailThread: {
    label: "Gmail thread (3 messages, ~1KB)",
    text: `Message 1:
From: Alice Chen <alice.chen@techstart.io>
Hey Bob, can you send me the contract? My address is 456 Oak Avenue, Austin, TX 78701.
My personal email is alice.chen.personal@gmail.com, phone: (512) 555-0147.

Message 2:
From: Bob Martinez <bob.m@techstart.io>
Sure Alice. I've also CC'd our lawyer Michael O'Brien <mobrien@lawfirm.com>.
His office is at 789 Pine Rd, Suite 200, Dallas, TX 75201, phone +1-214-555-0199.
The contract references your passport number X12345678.

Message 3:
From: Michael O'Brien <mobrien@lawfirm.com>
Thanks Bob. Alice, I'll need your date of birth and driver's license number for
the notarization. You can also reach my assistant Jennifer Lopez at ext 4521 or
jennifer.l@lawfirm.com. Our Federal Tax ID is 87-1234567.`,
  },

  slackMessages: {
    label: "Slack channel messages",
    text: `[10:15] @david.wilson: Hey team, the new client is Maria Garcia from Barcelona.
Her email is maria.garcia@empresa.es and mobile is +34 612 345 678.

[10:17] @emma.taylor: Got it. I've set up the account under Company: Empresa Tecnológica S.L.,
VAT number ES-B12345678. Their office is at Carrer de Mallorca 401, 08013 Barcelona.

[10:22] @david.wilson: Perfect. Maria said the technical contact is François Dubois
<f.dubois@empresa.es>, based in their Paris office at 15 Rue de Rivoli, 75001 Paris.
His French mobile is +33 6 12 34 56 78.`,
  },

  microsoftContacts: {
    label: "MS Graph contacts response (JSON)",
    text: JSON.stringify({
      value: [
        {
          displayName: "Dr. James Thompson",
          emailAddresses: [{ address: "j.thompson@hospital.org" }],
          mobilePhone: "+44 7700 900123",
          businessPhones: ["+44 20 7946 0958"],
          homeAddress: {
            street: "42 Baker Street",
            city: "London",
            postalCode: "NW1 6XE",
            countryOrRegion: "United Kingdom",
          },
          birthday: "1985-03-15",
          personalNotes: "Met at conference. SSN mentioned: 987-65-4320",
        },
        {
          displayName: "Yuki Tanaka",
          emailAddresses: [{ address: "y.tanaka@company.co.jp" }],
          mobilePhone: "+81 90-1234-5678",
          homeAddress: {
            street: "1-2-3 Shibuya",
            city: "Tokyo",
            postalCode: "150-0002",
          },
        },
      ],
    }),
  },

  notionPage: {
    label: "Notion page content",
    text: `# Team Directory

## Engineering
- **Lead**: Robert Chen (robert.chen@company.com, ext 2001)
  - Based in Seattle, WA. Employee ID: EMP-2019-0042
- **Senior Dev**: Priya Patel (priya.p@company.com)
  - Remote from Mumbai. Passport: K1234567

## Sales
- **Director**: Thomas Anderson (t.anderson@company.com, +1-555-0101)
  - Office: 200 Park Avenue, New York, NY 10166
  - Corporate Amex: 3782 822463 10005`,
  },

  shortText: {
    label: "Short text (1 sentence)",
    text: "Please email john.doe@example.com or call 555-0123.",
  },
};

// ── Benchmark runner ─────────────────────────────────────────────────────────

interface BenchResult {
  model: string;
  payload: string;
  inputChars: number;
  coldStartMs: number;
  warmAvgMs: number;
  warmP95Ms: number;
  entitiesFound: number;
  entities: string[];
}

async function benchmarkModel(
  modelId: string,
  modelLabel: string,
): Promise<BenchResult[]> {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`Loading model: ${modelLabel}`);
  console.log(`  Model ID: ${modelId}`);
  console.log(`${"═".repeat(70)}`);

  const coldStart = performance.now();
  const ner: TokenClassificationPipeline = await pipeline(
    "token-classification",
    modelId,
    { dtype: "q8" }, // 8-bit quantized for smaller + faster on CPU
  );
  const coldMs = performance.now() - coldStart;
  console.log(`  Cold start (model load): ${coldMs.toFixed(0)}ms`);

  const results: BenchResult[] = [];

  for (const [key, { label, text }] of Object.entries(PAYLOADS)) {
    // Warm-up run (JIT, cache)
    await ner(text);

    // Timed runs
    const RUNS = 10;
    const times: number[] = [];

    for (let i = 0; i < RUNS; i++) {
      const start = performance.now();
      await ner(text);
      times.push(performance.now() - start);
    }

    // Get entities from last run for display
    const entities = await ner(text, { ignore_labels: [] });
    const entityList = (entities as Array<{ entity_group?: string; word: string; score: number }>)
      .filter((e) => e.score > 0.5)
      .map((e) => `${e.entity_group || "?"}:"${e.word}" (${(e.score * 100).toFixed(0)}%)`);

    times.sort((a, b) => a - b);
    const avg = times.reduce((s, t) => s + t, 0) / times.length;
    const p95 = times[Math.floor(times.length * 0.95)];

    results.push({
      model: modelLabel,
      payload: label,
      inputChars: text.length,
      coldStartMs: coldMs,
      warmAvgMs: avg,
      warmP95Ms: p95!,
      entitiesFound: entityList.length,
      entities: entityList.slice(0, 15), // cap display
    });

    console.log(`\n  ${label} (${text.length} chars):`);
    console.log(`    Warm avg: ${avg.toFixed(1)}ms | P95: ${p95!.toFixed(1)}ms`);
    console.log(`    Entities (${entityList.length}): ${entityList.slice(0, 8).join(", ")}${entityList.length > 8 ? "..." : ""}`);
  }

  // Cleanup
  await ner.dispose();

  return results;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("PII NER Benchmark — Transformers.js on CPU");
  console.log(`Node.js ${process.version} | Platform: ${process.platform} ${process.arch}`);
  console.log(`CPU threads: ${env.backends.onnx.wasm.numThreads} (constrained to single-thread)`);
  console.log(`Date: ${new Date().toISOString()}`);

  const allResults: BenchResult[] = [];

  // Model 1: Piiranha (PII-specific, 17 entity types)
  try {
    const r = await benchmarkModel(
      "onnx-community/piiranha-v1-detect-personal-information-ONNX",
      "Piiranha v1 (PII-specific)",
    );
    allResults.push(...r);
  } catch (err) {
    console.error("Piiranha failed:", err);
  }

  // Model 2: BERT-base-NER (general NER — person/location/org/misc)
  try {
    const r = await benchmarkModel(
      "Xenova/bert-base-NER",
      "BERT-base-NER (general)",
    );
    allResults.push(...r);
  } catch (err) {
    console.error("BERT-base-NER failed:", err);
  }

  // ── Summary table ────────────────────────────────────────────────────────
  console.log(`\n\n${"═".repeat(90)}`);
  console.log("SUMMARY");
  console.log("═".repeat(90));
  console.log(
    "Model".padEnd(28) +
      "Payload".padEnd(32) +
      "Chars".padStart(6) +
      "Avg(ms)".padStart(10) +
      "P95(ms)".padStart(10) +
      "Entities".padStart(10),
  );
  console.log("─".repeat(90));

  for (const r of allResults) {
    console.log(
      r.model.padEnd(28) +
        r.payload.padEnd(32) +
        String(r.inputChars).padStart(6) +
        r.warmAvgMs.toFixed(1).padStart(10) +
        r.warmP95Ms.toFixed(1).padStart(10) +
        String(r.entitiesFound).padStart(10),
    );
  }

  console.log("─".repeat(90));
  console.log(`Cold start — Piiranha: ${allResults[0]?.coldStartMs.toFixed(0) ?? "N/A"}ms`);
  console.log(`Cold start — BERT-NER: ${allResults.find((r) => r.model.includes("BERT"))?.coldStartMs.toFixed(0) ?? "N/A"}ms`);

  // ── Azure Container Apps context ───────────────────────────────────────
  console.log(`\n${"═".repeat(90)}`);
  console.log("AZURE CONTAINER APPS CONTEXT");
  console.log("═".repeat(90));

  const piranhaAvgs = allResults
    .filter((r) => r.model.includes("Piiranha"))
    .map((r) => r.warmAvgMs);
  const maxPiiMs = Math.max(...piranhaAvgs);

  console.log(`Worst-case Piiranha inference: ${maxPiiMs.toFixed(1)}ms`);
  console.log(`Typical provider API latency: 50-500ms`);
  console.log(`PII overhead as % of total: ${((maxPiiMs / 200) * 100).toFixed(1)}% (vs 200ms provider call)`);
  console.log(`Single-thread throughput: ~${(1000 / maxPiiMs).toFixed(0)} inferences/sec`);
  console.log(`\nNote: ACA runs on shared vCPUs (AMD EPYC). Expect ~1.5-2x slower than local M-series/desktop CPUs.`);
  console.log(`With WASM multi-threading (4 threads), expect ~2-3x faster than these single-thread numbers.`);
}

main().catch(console.error);
