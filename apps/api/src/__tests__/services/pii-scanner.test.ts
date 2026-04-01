import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  luhn, verhoeff, ibanMod97, mod11, weightedMod10,
  italianFiscalCodeCheck, spanishNifCheck, finnishPicCheck,
  usBankRoutingCheck, extractDigits,
} from "../../services/pii/checksums.js";
import { enhanceScoreWithContext } from "../../services/pii/context.js";
import { scanText } from "../../services/pii/scanner.js";
import { compilePiiRedactor } from "../../services/pii/index.js";
import { resolveRecognizers } from "../../services/pii/recognizers/index.js";

// =============================================================================
// Checksum Validators
// =============================================================================

describe("PII Checksums", () => {
  describe("Luhn", () => {
    it("validates a known-good credit card number", () => {
      assert.ok(luhn("4532015112345670"));
    });
    it("rejects an invalid credit card number", () => {
      assert.ok(!luhn("4532015112345671"));
    });
    it("validates Visa test card 4111111111111111", () => {
      assert.ok(luhn("4111111111111111"));
    });
    it("handles dashes in input", () => {
      assert.ok(luhn("4111-1111-1111-1111"));
    });
  });

  describe("Verhoeff", () => {
    it("validates a known-good Aadhaar number", () => {
      assert.ok(verhoeff("496107854310"));
    });
    it("rejects a bad check digit", () => {
      assert.ok(!verhoeff("496107854311"));
    });
  });

  describe("IBAN mod-97", () => {
    it("validates DE89370400440532013000", () => {
      assert.ok(ibanMod97("DE89370400440532013000"));
    });
    it("validates GB29NWBK60161331926819", () => {
      assert.ok(ibanMod97("GB29NWBK60161331926819"));
    });
    it("validates with spaces", () => {
      assert.ok(ibanMod97("DE89 3704 0044 0532 0130 00"));
    });
    it("rejects bad check digits", () => {
      assert.ok(!ibanMod97("DE00370400440532013000"));
    });
  });

  describe("Italian fiscal code", () => {
    it("validates RSSMRA85M01H501Q", () => {
      assert.ok(italianFiscalCodeCheck("RSSMRA85M01H501Q"));
    });
    it("validates case-insensitive", () => {
      assert.ok(italianFiscalCodeCheck("rssmra85m01h501q"));
    });
    it("rejects wrong control char", () => {
      assert.ok(!italianFiscalCodeCheck("RSSMRA85M01H501A"));
    });
    it("rejects wrong length", () => {
      assert.ok(!italianFiscalCodeCheck("RSSMRA85M01H501"));
    });
  });

  describe("Spanish NIF", () => {
    it("validates 12345678Z", () => {
      assert.ok(spanishNifCheck("12345678Z"));
    });
    it("rejects wrong letter", () => {
      assert.ok(!spanishNifCheck("12345678A"));
    });
    it("validates NIE X2109873Z", () => {
      assert.ok(spanishNifCheck("X2109873Z"));
    });
  });

  describe("Finnish PIC", () => {
    it("validates 131052-308T", () => {
      assert.ok(finnishPicCheck("131052-308T"));
    });
    it("rejects wrong control char", () => {
      assert.ok(!finnishPicCheck("131052-308A"));
    });
  });

  describe("US bank routing", () => {
    it("validates 021000021 (JP Morgan Chase)", () => {
      assert.ok(usBankRoutingCheck("021000021"));
    });
    it("rejects 123456789", () => {
      assert.ok(!usBankRoutingCheck("123456789"));
    });
  });

  describe("extractDigits", () => {
    it("strips dashes and spaces", () => {
      assert.deepEqual(extractDigits("123-45 6789"), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
  });
});

// =============================================================================
// Context Word Enhancement
// =============================================================================

describe("PII Context Words", () => {
  it("boosts score when context word is found", () => {
    const text = "My credit card is 4111111111111111";
    const score = enhanceScoreWithContext(text, 18, 0.5, ["credit", "card"]);
    assert.ok(score > 0.5, `expected boost, got ${score}`);
    assert.ok(score <= 1.0);
  });

  it("does not boost when no context words found", () => {
    const text = "Random text 4111111111111111";
    const score = enhanceScoreWithContext(text, 12, 0.5, ["credit", "card"]);
    assert.equal(score, 0.5);
  });

  it("returns base score for empty context words", () => {
    const score = enhanceScoreWithContext("anything", 3, 0.6, []);
    assert.equal(score, 0.6);
  });
});

// =============================================================================
// Recognizer Registry
// =============================================================================

describe("PII Recognizer Registry", () => {
  it("resolves individual types", () => {
    const recs = resolveRecognizers(["email", "credit_card"]);
    assert.equal(recs.length, 2);
    assert.equal(recs[0]!.id, "email");
    assert.equal(recs[1]!.id, "credit_card");
  });

  it("resolves group alias contact", () => {
    const recs = resolveRecognizers(["contact"]);
    const ids = recs.map(r => r.id);
    assert.ok(ids.includes("email"));
    assert.ok(ids.includes("phone"));
    assert.ok(!ids.includes("url"), "url should not be in contact group (causes false positives on API response URLs)");
  });

  it("resolves group alias financial", () => {
    const recs = resolveRecognizers(["financial"]);
    const ids = recs.map(r => r.id);
    assert.ok(ids.includes("credit_card"));
    assert.ok(ids.includes("iban"));
    assert.ok(ids.includes("crypto_wallet"));
  });

  it("resolves legacy alias ssn → us_ssn", () => {
    const recs = resolveRecognizers(["ssn"]);
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.id, "us_ssn");
  });

  it("deduplicates when group and individual overlap", () => {
    const recs = resolveRecognizers(["email", "contact"]);
    const emailCount = recs.filter(r => r.id === "email").length;
    assert.equal(emailCount, 1);
  });

  it("returns empty for unknown type", () => {
    const recs = resolveRecognizers(["nonexistent_type"]);
    assert.equal(recs.length, 0);
  });

  it("resolves all_pii to 30+ recognizers", () => {
    const recs = resolveRecognizers(["all_pii"]);
    assert.ok(recs.length >= 30, `expected ≥30 recognizers, got ${recs.length}`);
  });
});

// =============================================================================
// Scanner — Generic Recognizers
// =============================================================================

describe("PII Scanner — Email", () => {
  it("detects email addresses", () => {
    const recs = resolveRecognizers(["email"]);
    const entities = scanText("Contact john@example.com for details", recs);
    assert.equal(entities.length, 1);
    assert.equal(entities[0]!.text, "john@example.com");
    assert.equal(entities[0]!.type, "email");
  });

  it("detects multiple emails", () => {
    const recs = resolveRecognizers(["email"]);
    const entities = scanText("Send to alice@test.org and bob@company.co.uk", recs);
    assert.equal(entities.length, 2);
  });
});

describe("PII Scanner — Credit Card", () => {
  it("detects valid Luhn credit card", () => {
    const recs = resolveRecognizers(["credit_card"]);
    const entities = scanText("Card: 4111-1111-1111-1111", recs);
    assert.ok(entities.length >= 1);
    assert.ok(entities.some(e => e.type === "credit_card"));
  });

  it("rejects invalid Luhn number", () => {
    const recs = resolveRecognizers(["credit_card"]);
    const entities = scanText("Card: 4111-1111-1111-1112", recs);
    assert.equal(entities.filter(e => e.type === "credit_card").length, 0);
  });

  it("detects Amex format", () => {
    const recs = resolveRecognizers(["credit_card"]);
    const entities = scanText("Amex: 378282246310005", recs);
    assert.ok(entities.some(e => e.type === "credit_card"));
  });
});

describe("PII Scanner — IBAN", () => {
  it("detects valid German IBAN", () => {
    const recs = resolveRecognizers(["iban"]);
    const entities = scanText("IBAN: DE89370400440532013000", recs);
    assert.ok(entities.length >= 1);
    assert.ok(entities.some(e => e.type === "iban"));
  });

  it("rejects IBAN with bad check digits", () => {
    const recs = resolveRecognizers(["iban"]);
    const entities = scanText("IBAN: DE00370400440532013000", recs);
    assert.equal(entities.filter(e => e.type === "iban").length, 0);
  });
});

describe("PII Scanner — IP Address", () => {
  it("detects IPv4", () => {
    const recs = resolveRecognizers(["ip_address"]);
    const entities = scanText("Server IP: 192.168.1.100", recs);
    assert.ok(entities.some(e => e.type === "ip_address"));
  });
});

// =============================================================================
// Scanner — US Recognizers
// =============================================================================

describe("PII Scanner — US SSN", () => {
  it("detects valid SSN with context", () => {
    const recs = resolveRecognizers(["us_ssn"]);
    const entities = scanText("SSN: 123-45-6789", recs);
    assert.ok(entities.length >= 1);
    assert.equal(entities[0]!.type, "us_ssn");
  });

  it("rejects SSN with 000 area", () => {
    const recs = resolveRecognizers(["us_ssn"]);
    const entities = scanText("SSN: 000-45-6789", recs);
    assert.equal(entities.length, 0);
  });

  it("rejects SSN with 666 area", () => {
    const recs = resolveRecognizers(["us_ssn"]);
    const entities = scanText("SSN: 666-45-6789", recs);
    assert.equal(entities.length, 0);
  });

  it("rejects SSN with 9xx area", () => {
    const recs = resolveRecognizers(["us_ssn"]);
    const entities = scanText("SSN: 900-45-6789", recs);
    assert.equal(entities.length, 0);
  });

  it("rejects SSN with 00 group", () => {
    const recs = resolveRecognizers(["us_ssn"]);
    const entities = scanText("SSN: 123-00-6789", recs);
    assert.equal(entities.length, 0);
  });

  it("rejects SSN with 0000 serial", () => {
    const recs = resolveRecognizers(["us_ssn"]);
    const entities = scanText("SSN: 123-45-0000", recs);
    assert.equal(entities.length, 0);
  });
});

describe("PII Scanner — US Bank Routing", () => {
  it("detects valid routing number with context", () => {
    const recs = resolveRecognizers(["us_bank_routing"]);
    const entities = scanText("routing number: 021000021", recs);
    assert.ok(entities.length >= 1);
  });
});

// =============================================================================
// Scanner — UK Recognizers
// =============================================================================

describe("PII Scanner — UK NINO", () => {
  it("detects valid NINO with context", () => {
    const recs = resolveRecognizers(["uk_nino"]);
    const entities = scanText("national insurance: AB123456C", recs);
    assert.ok(entities.length >= 1);
    assert.equal(entities[0]!.type, "uk_nino");
  });

  it("rejects NINO with invalid prefix BG", () => {
    const recs = resolveRecognizers(["uk_nino"]);
    const entities = scanText("national insurance: BG123456C", recs);
    assert.equal(entities.length, 0);
  });
});

// =============================================================================
// Scanner — Italy Recognizers
// =============================================================================

describe("PII Scanner — Italian Fiscal Code", () => {
  it("detects valid fiscal code", () => {
    const recs = resolveRecognizers(["it_fiscal_code"]);
    const entities = scanText("codice fiscale: RSSMRA85M01H501Q", recs);
    assert.ok(entities.length >= 1);
    assert.equal(entities[0]!.type, "it_fiscal_code");
  });

  it("rejects fiscal code with wrong control char", () => {
    const recs = resolveRecognizers(["it_fiscal_code"]);
    const entities = scanText("codice fiscale: RSSMRA85M01H501A", recs);
    assert.equal(entities.length, 0);
  });
});

// =============================================================================
// Scanner — Spain Recognizers
// =============================================================================

describe("PII Scanner — Spanish NIF", () => {
  it("detects valid NIF with context", () => {
    const recs = resolveRecognizers(["es_nif"]);
    const entities = scanText("DNI: 12345678Z", recs);
    assert.ok(entities.length >= 1);
    assert.equal(entities[0]!.type, "es_nif");
  });

  it("rejects NIF with wrong letter", () => {
    const recs = resolveRecognizers(["es_nif"]);
    const entities = scanText("DNI: 12345678A", recs);
    assert.equal(entities.length, 0);
  });
});

// =============================================================================
// Scanner — India Recognizers
// =============================================================================

describe("PII Scanner — India PAN", () => {
  it("detects valid PAN with context", () => {
    const recs = resolveRecognizers(["in_pan"]);
    const entities = scanText("PAN card: ABCPD1234E", recs);
    assert.ok(entities.length >= 1);
    assert.equal(entities[0]!.type, "in_pan");
  });

  it("rejects PAN with invalid entity type char", () => {
    const recs = resolveRecognizers(["in_pan"]);
    // 4th char 'Z' is not a valid entity type
    const entities = scanText("PAN card: ABCZD1234E", recs);
    assert.equal(entities.length, 0);
  });
});

// =============================================================================
// Scanner — Phone (libphonenumber-js)
// =============================================================================

describe("PII Scanner — Phone", () => {
  it("detects US phone number (international format)", () => {
    const recs = resolveRecognizers(["phone"]);
    const entities = scanText("Call +1 212 555 1234", recs);
    assert.ok(entities.length >= 1);
    assert.equal(entities[0]!.type, "phone");
  });

  it("detects Italian phone number", () => {
    const recs = resolveRecognizers(["phone"]);
    const entities = scanText("Telefono: +39 348 384 6623", recs);
    assert.ok(entities.length >= 1);
  });

  it("detects UK phone number", () => {
    const recs = resolveRecognizers(["phone"]);
    const entities = scanText("Ring +44 7911 123456", recs);
    assert.ok(entities.length >= 1);
  });

  it("detects French phone number", () => {
    const recs = resolveRecognizers(["phone"]);
    const entities = scanText("Tel: +33 1 42 86 82 82", recs);
    assert.ok(entities.length >= 1);
  });
});

// =============================================================================
// Redactor (end-to-end)
// =============================================================================

describe("PII Redactor", () => {
  it("compiles and redacts emails", () => {
    const redactor = compilePiiRedactor([{ type: "email" }]);
    assert.ok(redactor !== null);
    const result = redactor.redact("Send to john@example.com please");
    assert.equal(result, "Send to [REDACTED] please");
  });

  it("uses custom replacement string", () => {
    const redactor = compilePiiRedactor(
      [{ type: "email", replacement: "***" }],
    );
    assert.ok(redactor !== null);
    const result = redactor.redact("Email: test@example.com");
    assert.equal(result, "Email: ***");
  });

  it("redacts multiple PII types in one pass", () => {
    const redactor = compilePiiRedactor([
      { type: "email" },
      { type: "credit_card" },
    ]);
    assert.ok(redactor !== null);
    const result = redactor.redact(
      "Email john@test.com, card 4111-1111-1111-1111"
    );
    assert.ok(!result.includes("john@test.com"));
    assert.ok(!result.includes("4111-1111-1111-1111"));
  });

  it("handles group aliases (contact)", () => {
    const redactor = compilePiiRedactor([{ type: "contact" }]);
    assert.ok(redactor !== null);
    const result = redactor.redact("Email me at hello@example.com");
    assert.ok(!result.includes("hello@example.com"));
  });

  it("handles legacy ssn alias", () => {
    const redactor = compilePiiRedactor([{ type: "ssn" }]);
    assert.ok(redactor !== null);
    // "SSN" context word boosts the score above threshold
    const result = redactor.redact("SSN: 123-45-6789");
    assert.ok(!result.includes("123-45-6789"), `expected redaction but got: ${result}`);
  });

  it("returns null for empty patterns", () => {
    const redactor = compilePiiRedactor([]);
    assert.equal(redactor, null);
  });

  it("returns null for unknown types", () => {
    const redactor = compilePiiRedactor([{ type: "nonexistent" }]);
    assert.equal(redactor, null);
  });

  it("supports custom regex patterns", () => {
    const redactor = compilePiiRedactor([
      { type: "custom", pattern: "SECRET-\\d+" },
    ]);
    assert.ok(redactor !== null);
    const result = redactor.redact("Code: SECRET-12345 is confidential");
    assert.equal(result, "Code: [REDACTED] is confidential");
  });

  it("leaves text unchanged when no PII found", () => {
    const redactor = compilePiiRedactor([{ type: "email" }]);
    assert.ok(redactor !== null);
    const text = "Hello world, no PII here";
    assert.equal(redactor.redact(text), text);
  });

  // ── Formatting tag stripping (Google <wbr /> injection) ──────────

  it("redacts Bitcoin Bech32 address split by <wbr />", () => {
    const redactor = compilePiiRedactor([{ type: "crypto_wallet" }]);
    assert.ok(redactor !== null);
    // Google Calendar injects <wbr /> mid-token
    const input = "bc1qw508d6qejxtdg4y5r3zarvary0<wbr />c5xw7kv8f3t4";
    const result = redactor.redact(input);
    assert.ok(!result.includes("c5xw7kv8f3t4"), `tail leaked: ${result}`);
    assert.ok(!result.includes("bc1qw508d6qejxtdg4y5r3zarvary0"), `head leaked: ${result}`);
  });

  it("redacts Ethereum address split by <wbr />", () => {
    const redactor = compilePiiRedactor([{ type: "crypto_wallet" }]);
    assert.ok(redactor !== null);
    const input = "addr: 0x742d35Cc6634C0532925a3b844Bc<wbr />9e7595f2bD18";
    const result = redactor.redact(input);
    assert.ok(!result.includes("0x742d35Cc"), `eth address leaked: ${result}`);
  });

  it("redacts email split by <wbr />", () => {
    const redactor = compilePiiRedactor([{ type: "email" }]);
    assert.ok(redactor !== null);
    const input = "contact test.user+tag@subdomain.<wbr />example.co.uk please";
    const result = redactor.redact(input);
    assert.ok(!result.includes("test.user"), `email leaked: ${result}`);
    assert.ok(!result.includes("example.co.uk"), `email domain leaked: ${result}`);
  });

  it("handles <wbr> (no slash) and &shy; entities", () => {
    const redactor = compilePiiRedactor([{ type: "email" }]);
    assert.ok(redactor !== null);
    const input = "alice@exam<wbr>ple.com and bob@ex&shy;ample.org";
    const result = redactor.redact(input);
    assert.ok(!result.includes("alice"), `email leaked through <wbr>: ${result}`);
    assert.ok(!result.includes("bob"), `email leaked through &shy;: ${result}`);
  });

  it("leaves text unchanged when formatting tags are present but no PII", () => {
    const redactor = compilePiiRedactor([{ type: "email" }]);
    assert.ok(redactor !== null);
    const input = "This is a long<wbr /> word with no PII";
    assert.equal(redactor.redact(input), input);
  });

  // ── Concatenated text (no whitespace boundaries) ──────────────

  it("redacts SSN in concatenated text (digit→uppercase word)", () => {
    const redactor = compilePiiRedactor([{ type: "us_ssn" }]);
    assert.ok(redactor !== null);
    // Simulates Notion title: "SSN: 123-45-6789ITIN: ..."
    const input = "SSN: 123-45-6789ITIN: 999-88-7777";
    const result = redactor.redact(input);
    assert.ok(!result.includes("123-45-6789"), `SSN leaked: ${result}`);
  });

  it("redacts credit card after phone number (concatenated)", () => {
    const redactor = compilePiiRedactor([
      { type: "phone" },
      { type: "credit_card" },
    ]);
    assert.ok(redactor !== null);
    const input = "Phone (US): +1 212 555 1234Credit Card: 4111-1111-1111-1111";
    const result = redactor.redact(input);
    assert.ok(!result.includes("4111-1111-1111-1111"), `credit card leaked: ${result}`);
  });

  it("redacts multiple PII types concatenated without spaces", () => {
    const redactor = compilePiiRedactor([
      { type: "phone" },
      { type: "credit_card" },
      { type: "us_ssn" },
    ]);
    assert.ok(redactor !== null);
    const input = "Phone (US): +1 212 555 1234Phone (IT): +39 348 384 6623Credit Card: 4111-1111-1111-1111SSN: 123-45-6789";
    const result = redactor.redact(input);
    assert.ok(!result.includes("4111-1111-1111-1111"), `credit card leaked: ${result}`);
    assert.ok(!result.includes("123-45-6789"), `SSN leaked: ${result}`);
  });

  it("still redacts normally spaced text (regression)", () => {
    const redactor = compilePiiRedactor([
      { type: "email" },
      { type: "us_ssn" },
    ]);
    assert.ok(redactor !== null);
    const input = "Email: john@example.com SSN: 123-45-6789";
    const result = redactor.redact(input);
    assert.ok(!result.includes("john@example.com"), `email leaked: ${result}`);
    assert.ok(!result.includes("123-45-6789"), `SSN leaked: ${result}`);
  });

  it("handles both formatting tags AND concatenation", () => {
    const redactor = compilePiiRedactor([
      { type: "email" },
      { type: "us_ssn" },
    ]);
    assert.ok(redactor !== null);
    // Google-style formatting tags + Notion-style concatenation
    const input = "test.user@exam<wbr />ple.comSSN: 123-45-6789";
    const result = redactor.redact(input);
    assert.ok(!result.includes("test.user"), `email leaked through combined: ${result}`);
    assert.ok(!result.includes("123-45-6789"), `SSN leaked through combined: ${result}`);
  });

  it("does NOT break standalone Ethereum address (regression)", () => {
    const redactor = compilePiiRedactor([{ type: "crypto_wallet" }]);
    assert.ok(redactor !== null);
    // Ethereum addresses have digit→single-uppercase transitions (hex) that must NOT be split
    const input = "addr: 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18";
    const result = redactor.redact(input);
    // The address should be detected and redacted as one entity, not split
    assert.ok(!result.includes("0x742d35Cc"), `eth address should be redacted: ${result}`);
  });

  it("does NOT insert spaces in camelCase (regression)", () => {
    const redactor = compilePiiRedactor([{ type: "email" }]);
    assert.ok(redactor !== null);
    const input = "fieldName someValue test@example.com";
    const result = redactor.redact(input);
    // email should be redacted, but surrounding text should be unchanged
    assert.ok(result.includes("fieldName someValue"), `camelCase was broken: ${result}`);
    assert.ok(!result.includes("test@example.com"), `email leaked: ${result}`);
  });

  it("handles paren→letter transition (country code in parens)", () => {
    const redactor = compilePiiRedactor([{ type: "phone" }]);
    assert.ok(redactor !== null);
    const input = "1234(IT)+39 348 384 6623";
    const result = redactor.redact(input);
    assert.ok(!result.includes("348 384 6623"), `phone leaked: ${result}`);
  });
});
