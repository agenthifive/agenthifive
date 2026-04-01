/**
 * Gmail PII NER Test — Real email data through Transformers.js
 *
 * Fetches real Gmail messages and runs them through the Piiranha NER model
 * to evaluate PII detection on actual email content.
 *
 * Usage:
 *   # Set your Gmail access token (get from Google OAuth Playground or Model A)
 *   export GMAIL_TOKEN="ya29.a0..."
 *
 *   # Run (defaults: 10 messages, inbox)
 *   npx tsx apps/api/benchmarks/gmail-pii-test.ts
 *
 *   # Options
 *   npx tsx apps/api/benchmarks/gmail-pii-test.ts --count 20 --label INBOX --full
 *
 * Getting a token:
 *   Option A: Google OAuth Playground (https://developers.google.com/oauthplayground)
 *            → Select "Gmail API v1" → "gmail.readonly" → Authorize → Exchange → Copy access_token
 *   Option B: Platform Model A via vault/execute (if you have a Google connection)
 */

import { pipeline, env, type TokenClassificationPipeline } from "@huggingface/transformers";

// Force CPU-only, single-threaded
env.backends.onnx.wasm.numThreads = 1;

// ── Config ──────────────────────────────────────────────────────────────────

const GMAIL_TOKEN = process.env.GMAIL_TOKEN;
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface CliArgs {
  count: number;
  label: string;
  full: boolean; // --full: show full entity list (not capped)
  scoreThreshold: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const opts: CliArgs = { count: 10, label: "INBOX", full: false, scoreThreshold: 0.7 };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--count" && args[i + 1]) opts.count = parseInt(args[i + 1]!, 10);
    if (args[i] === "--label" && args[i + 1]) opts.label = args[i + 1]!;
    if (args[i] === "--full") opts.full = true;
    if (args[i] === "--threshold" && args[i + 1]) opts.scoreThreshold = parseFloat(args[i + 1]!);
  }

  return opts;
}

// ── Gmail API helpers ───────────────────────────────────────────────────────

interface GmailMessageRef {
  id: string;
  threadId: string;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessagePart {
  mimeType: string;
  headers: GmailHeader[];
  body: { data?: string; size: number };
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  payload: GmailMessagePart;
  internalDate: string;
}

async function gmailFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${GMAIL_TOKEN}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

async function listMessages(label: string, count: number): Promise<GmailMessageRef[]> {
  const res = await gmailFetch<{ messages?: GmailMessageRef[] }>(
    `/messages?labelIds=${label}&maxResults=${count}`,
  );
  return res.messages ?? [];
}

async function getMessage(id: string): Promise<GmailMessage> {
  return gmailFetch<GmailMessage>(`/messages/${id}?format=full`);
}

// ── MIME text extraction ────────────────────────────────────────────────────

function getHeader(part: GmailMessagePart, name: string): string {
  const h = part.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function extractTextFromParts(part: GmailMessagePart): string {
  // Direct text/plain body
  if (part.mimeType === "text/plain" && part.body.data) {
    return decodeBase64Url(part.body.data);
  }

  // Recurse into multipart
  if (part.parts) {
    // Prefer text/plain over text/html
    for (const sub of part.parts) {
      if (sub.mimeType === "text/plain" && sub.body.data) {
        return decodeBase64Url(sub.body.data);
      }
    }
    // Fallback: recurse deeper (nested multipart)
    for (const sub of part.parts) {
      const text = extractTextFromParts(sub);
      if (text) return text;
    }
  }

  // Last resort: HTML body, strip tags
  if (part.mimeType === "text/html" && part.body.data) {
    return stripHtml(decodeBase64Url(part.body.data));
  }

  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildEmailText(msg: GmailMessage): { subject: string; from: string; to: string; text: string; fullText: string } {
  const subject = getHeader(msg.payload, "Subject");
  const from = getHeader(msg.payload, "From");
  const to = getHeader(msg.payload, "To");
  const body = extractTextFromParts(msg.payload);

  // Build a combined text that resembles what Model B would return
  const fullText = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "",
    body,
  ].join("\n");

  return { subject, from, to, text: body, fullText };
}

// ── NER Analysis ────────────────────────────────────────────────────────────

interface PiiEntity {
  type: string;
  text: string;
  score: number;
  start: number;
  end: number;
}

// Piiranha actual entity labels (IOB tags, grouped by aggregation_strategy: "simple")
// The model uses its own label set — NOT generic NER labels.
// With aggregation, I-/B- prefixes are stripped and tokens are merged into entity_group.
const PII_LABELS = new Set([
  // Person names
  "GIVENNAME", "SURNAME",
  // Contact info
  "EMAIL", "TELEPHONENUM", "USERNAME",
  // Address components
  "STREET_ADDRESS", "CITY", "STATE", "ZIPCODE",
  // Financial
  "CREDITCARDNUMBER", "IBAN",
  // Identity
  "SOCIALNUM", "DRIVERLICENSE", "PASSPORT", "TAXID", "IDCARD",
  // Other
  "IP_ADDRESS", "DATEOFBIRTH", "PASSWORD", "URL",
  // Catch-all for any we missed
  "PERSON", "PHONE_NUM", "CREDIT_CARD", "ID_NUM",
]);

async function analyzeWithNer(
  ner: TokenClassificationPipeline,
  text: string,
  threshold: number,
): Promise<{ entities: PiiEntity[]; inferenceMs: number }> {
  // Truncate very long texts (BERT max is ~512 tokens, but we let the pipeline handle truncation)
  const input = text.length > 10000 ? text.slice(0, 10000) : text;

  const start = performance.now();
  // ignore_labels: [] ensures we see ALL entity types (default ignores "O" label)
  const raw = await ner(input, { ignore_labels: ["O"] });
  const inferenceMs = performance.now() - start;

  const entities = (raw as Array<{ entity_group?: string; entity?: string; word: string; score: number; start: number; end: number }>)
    .filter((e) => e.score >= threshold)
    .filter((e) => {
      // With aggregation, entity_group is set (e.g. "TELEPHONENUM").
      // Without aggregation, entity has the raw IOB tag (e.g. "I-TELEPHONENUM").
      const label = e.entity_group ?? e.entity?.replace(/^[BI]-/, "") ?? "";
      return PII_LABELS.has(label);
    })
    .map((e) => ({
      type: e.entity_group ?? e.entity?.replace(/^[BI]-/, "") ?? "UNKNOWN",
      text: e.word.trim(),
      score: e.score,
      start: e.start ?? 0,
      end: e.end ?? 0,
    }));

  return { entities, inferenceMs };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!GMAIL_TOKEN) {
    console.error("Error: GMAIL_TOKEN environment variable is required.\n");
    console.error("Get one from: https://developers.google.com/oauthplayground");
    console.error("  1. Select 'Gmail API v1' → 'gmail.readonly'");
    console.error("  2. Authorize APIs → Exchange authorization code");
    console.error("  3. Copy the access_token\n");
    console.error("Then run: GMAIL_TOKEN='ya29...' npx tsx apps/api/benchmarks/gmail-pii-test.ts");
    process.exit(1);
  }

  const args = parseArgs();

  console.log("Gmail PII NER Test — Real Email Data");
  console.log(`Node.js ${process.version} | Platform: ${process.platform} ${process.arch}`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Config: ${args.count} messages, label=${args.label}, threshold=${args.scoreThreshold}`);

  // ── Load model ──────────────────────────────────────────────────────────
  console.log("\nLoading Piiranha v1 model (PII-specific NER)...");
  const loadStart = performance.now();
  const ner = await pipeline(
    "token-classification",
    "onnx-community/piiranha-v1-detect-personal-information-ONNX",
    { dtype: "q8" },
  );
  console.log(`Model loaded in ${((performance.now() - loadStart) / 1000).toFixed(1)}s`);

  // ── Fetch messages ──────────────────────────────────────────────────────
  console.log(`\nFetching ${args.count} messages from Gmail (label: ${args.label})...`);
  const refs = await listMessages(args.label, args.count);
  console.log(`Got ${refs.length} message refs.`);

  if (refs.length === 0) {
    console.log("No messages found. Try a different label (INBOX, SENT, IMPORTANT).");
    await ner.dispose();
    return;
  }

  // Fetch full messages (parallel, batched to avoid rate limits)
  const BATCH_SIZE = 5;
  const messages: GmailMessage[] = [];
  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    const batch = refs.slice(i, i + BATCH_SIZE);
    const fetched = await Promise.all(batch.map((r) => getMessage(r.id)));
    messages.push(...fetched);
    if (i + BATCH_SIZE < refs.length) {
      console.log(`  Fetched ${messages.length}/${refs.length} messages...`);
    }
  }
  console.log(`Fetched all ${messages.length} messages.`);

  // ── Warm up NER ─────────────────────────────────────────────────────────
  console.log("\nWarming up NER model...");
  await ner("Warm-up text with john@example.com");

  // ── Analyze each message ────────────────────────────────────────────────
  console.log(`\n${"═".repeat(90)}`);
  console.log("RESULTS");
  console.log("═".repeat(90));

  interface MessageResult {
    index: number;
    subject: string;
    from: string;
    chars: number;
    inferenceMs: number;
    entities: PiiEntity[];
  }

  const results: MessageResult[] = [];
  let totalInferenceMs = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const email = buildEmailText(msg);

    const { entities, inferenceMs } = await analyzeWithNer(ner, email.fullText, args.scoreThreshold);
    totalInferenceMs += inferenceMs;

    results.push({
      index: i + 1,
      subject: email.subject.slice(0, 60),
      from: email.from.slice(0, 40),
      chars: email.fullText.length,
      inferenceMs,
      entities,
    });

    // Print per-message result
    console.log(`\n── Message ${i + 1}/${messages.length} ──`);
    console.log(`  From: ${email.from.slice(0, 60)}`);
    console.log(`  Subject: ${email.subject.slice(0, 70)}`);
    console.log(`  Size: ${email.fullText.length} chars | Inference: ${inferenceMs.toFixed(1)}ms`);

    if (entities.length === 0) {
      console.log("  PII: (none detected)");
    } else {
      // Group by type
      const grouped = new Map<string, PiiEntity[]>();
      for (const e of entities) {
        const list = grouped.get(e.type) ?? [];
        list.push(e);
        grouped.set(e.type, list);
      }

      console.log(`  PII found (${entities.length} entities):`);
      for (const [type, ents] of grouped) {
        const display = args.full ? ents : ents.slice(0, 5);
        const items = display.map((e) => `"${e.text}" (${(e.score * 100).toFixed(0)}%)`).join(", ");
        const more = ents.length > display.length ? ` +${ents.length - display.length} more` : "";
        console.log(`    ${type}: ${items}${more}`);
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n\n${"═".repeat(90)}`);
  console.log("SUMMARY");
  console.log("═".repeat(90));

  const totalEntities = results.reduce((s, r) => s + r.entities.length, 0);
  const totalChars = results.reduce((s, r) => s + r.chars, 0);
  const avgInference = totalInferenceMs / results.length;
  const maxInference = Math.max(...results.map((r) => r.inferenceMs));
  const minInference = Math.min(...results.map((r) => r.inferenceMs));

  console.log(`Messages analyzed: ${results.length}`);
  console.log(`Total characters:  ${totalChars.toLocaleString()}`);
  console.log(`Total PII entities: ${totalEntities}`);
  console.log(`Avg entities/msg:  ${(totalEntities / results.length).toFixed(1)}`);
  console.log(`\nInference time:`);
  console.log(`  Average: ${avgInference.toFixed(1)}ms`);
  console.log(`  Min:     ${minInference.toFixed(1)}ms`);
  console.log(`  Max:     ${maxInference.toFixed(1)}ms`);
  console.log(`  Total:   ${totalInferenceMs.toFixed(0)}ms for ${results.length} messages`);

  // Entity type breakdown
  const typeCount = new Map<string, number>();
  for (const r of results) {
    for (const e of r.entities) {
      typeCount.set(e.type, (typeCount.get(e.type) ?? 0) + 1);
    }
  }

  if (typeCount.size > 0) {
    console.log("\nPII type breakdown:");
    const sorted = [...typeCount.entries()].sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sorted) {
      console.log(`  ${type.padEnd(20)} ${count}`);
    }
  }

  // Messages with no PII
  const noPii = results.filter((r) => r.entities.length === 0).length;
  console.log(`\nMessages with no PII detected: ${noPii}/${results.length} (${((noPii / results.length) * 100).toFixed(0)}%)`);

  // Performance implications
  console.log(`\n${"═".repeat(90)}`);
  console.log("PERFORMANCE CONTEXT (Azure Container Apps)");
  console.log("═".repeat(90));
  console.log(`Avg inference per message: ${avgInference.toFixed(1)}ms`);
  console.log(`Typical provider API call: 200-500ms`);
  console.log(`PII overhead: ${((avgInference / 300) * 100).toFixed(1)}% of typical API call (300ms)`);
  console.log(`On ACA shared vCPUs (1.5-2x slower): ~${(avgInference * 1.75).toFixed(0)}ms avg`);
  console.log(`With 4 WASM threads: ~${(avgInference * 1.75 / 2.5).toFixed(0)}ms avg`);

  await ner.dispose();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
