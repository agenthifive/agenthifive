import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isPrivateIP,
  checkHostSafety,
  canonicalizeUrl,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_PAYLOAD_SIZE_BYTES,
  DEFAULT_MAX_RESPONSE_SIZE_BYTES,
} from "../../utils/ssrf-protection.js";

// =============================================================================
// isPrivateIP
// =============================================================================

describe("isPrivateIP", () => {
  // ---------------------------------------------------------------------------
  // IPv4 Tests
  // ---------------------------------------------------------------------------
  describe("IPv4", () => {
    it("should detect loopback addresses as private", () => {
      console.log("[SSRF TEST] Checking IPv4 loopback addresses");
      assert.equal(isPrivateIP("127.0.0.1"), true, "127.0.0.1 is loopback");
      assert.equal(isPrivateIP("127.255.255.255"), true, "127.255.255.255 is loopback");
      assert.equal(isPrivateIP("127.0.0.0"), true, "127.0.0.0 is loopback");
      assert.equal(isPrivateIP("127.100.50.25"), true, "127.100.50.25 is loopback");
    });

    it("should detect RFC 1918 10.0.0.0/8 addresses as private", () => {
      console.log("[SSRF TEST] Checking RFC 1918 10.0.0.0/8 range");
      assert.equal(isPrivateIP("10.0.0.1"), true, "10.0.0.1 is private");
      assert.equal(isPrivateIP("10.255.255.255"), true, "10.255.255.255 is private");
      assert.equal(isPrivateIP("10.0.0.0"), true, "10.0.0.0 is private");
    });

    it("should detect RFC 1918 172.16.0.0/12 addresses as private", () => {
      console.log("[SSRF TEST] Checking RFC 1918 172.16.0.0/12 range");
      assert.equal(isPrivateIP("172.16.0.1"), true, "172.16.0.1 is private");
      assert.equal(isPrivateIP("172.31.255.255"), true, "172.31.255.255 is private");
      assert.equal(isPrivateIP("172.20.0.1"), true, "172.20.0.1 is private");
    });

    it("should detect RFC 1918 192.168.0.0/16 addresses as private", () => {
      console.log("[SSRF TEST] Checking RFC 1918 192.168.0.0/16 range");
      assert.equal(isPrivateIP("192.168.1.1"), true, "192.168.1.1 is private");
      assert.equal(isPrivateIP("192.168.0.0"), true, "192.168.0.0 is private");
      assert.equal(isPrivateIP("192.168.255.255"), true, "192.168.255.255 is private");
    });

    it("should detect link-local addresses as private", () => {
      console.log("[SSRF TEST] Checking IPv4 link-local 169.254.0.0/16");
      assert.equal(isPrivateIP("169.254.1.1"), true, "169.254.1.1 is link-local");
      assert.equal(isPrivateIP("169.254.0.0"), true, "169.254.0.0 is link-local");
      assert.equal(isPrivateIP("169.254.255.255"), true, "169.254.255.255 is link-local");
    });

    it("should detect special-use addresses as private", () => {
      console.log("[SSRF TEST] Checking special-use IPv4 addresses");
      assert.equal(isPrivateIP("0.0.0.0"), true, "0.0.0.0 is 'this' network");
      assert.equal(isPrivateIP("100.64.0.1"), true, "100.64.0.1 is carrier-grade NAT");
      assert.equal(isPrivateIP("100.127.255.255"), true, "100.127.255.255 is end of CGNAT range");
      assert.equal(isPrivateIP("192.0.0.1"), true, "192.0.0.1 is IETF protocol assignments");
      assert.equal(isPrivateIP("192.0.2.1"), true, "192.0.2.1 is TEST-NET-1");
      assert.equal(isPrivateIP("198.51.100.1"), true, "198.51.100.1 is TEST-NET-2");
      assert.equal(isPrivateIP("203.0.113.1"), true, "203.0.113.1 is TEST-NET-3");
      assert.equal(isPrivateIP("198.18.0.1"), true, "198.18.0.1 is benchmarking");
    });

    it("should detect multicast, reserved, and broadcast addresses as private", () => {
      console.log("[SSRF TEST] Checking multicast/reserved/broadcast");
      assert.equal(isPrivateIP("224.0.0.1"), true, "224.0.0.1 is multicast");
      assert.equal(isPrivateIP("239.255.255.255"), true, "239.255.255.255 is multicast");
      assert.equal(isPrivateIP("240.0.0.1"), true, "240.0.0.1 is reserved");
      assert.equal(isPrivateIP("255.255.255.255"), true, "255.255.255.255 is broadcast");
    });

    it("should allow public IP addresses", () => {
      console.log("[SSRF TEST] Checking public IPv4 addresses");
      assert.equal(isPrivateIP("8.8.8.8"), false, "8.8.8.8 is public (Google DNS)");
      assert.equal(isPrivateIP("1.1.1.1"), false, "1.1.1.1 is public (Cloudflare DNS)");
      assert.equal(isPrivateIP("208.67.222.222"), false, "208.67.222.222 is public (OpenDNS)");
      assert.equal(isPrivateIP("93.184.216.34"), false, "93.184.216.34 is public");
    });

    it("should correctly handle edge cases at range boundaries", () => {
      console.log("[SSRF TEST] Checking IPv4 boundary edge cases");
      // 172.16.0.0/12 covers 172.16.0.0 - 172.31.255.255
      assert.equal(isPrivateIP("172.15.255.255"), false, "172.15.255.255 is just below the /12 range");
      assert.equal(isPrivateIP("172.32.0.0"), false, "172.32.0.0 is just above the /12 range");
      // 100.64.0.0/10 covers 100.64.0.0 - 100.127.255.255
      assert.equal(isPrivateIP("100.63.255.255"), false, "100.63.255.255 is just below CGNAT range");
      assert.equal(isPrivateIP("100.128.0.0"), false, "100.128.0.0 is just above CGNAT range");
    });

    it("should return false for invalid input", () => {
      console.log("[SSRF TEST] Checking invalid IPv4 input");
      assert.equal(isPrivateIP("not-an-ip"), false, "non-IP string returns false");
      assert.equal(isPrivateIP(""), false, "empty string returns false");
      assert.equal(isPrivateIP("999.999.999.999"), false, "out-of-range octets returns false");
      assert.equal(isPrivateIP("1.2.3"), false, "too few octets returns false");
    });
  });

  // ---------------------------------------------------------------------------
  // IPv6 Tests
  // ---------------------------------------------------------------------------
  describe("IPv6", () => {
    it("should detect loopback ::1 as private", () => {
      console.log("[SSRF TEST] Checking IPv6 loopback");
      assert.equal(isPrivateIP("::1"), true, "::1 is IPv6 loopback");
    });

    it("should detect unspecified address :: as private", () => {
      console.log("[SSRF TEST] Checking IPv6 unspecified");
      assert.equal(isPrivateIP("::"), true, ":: is IPv6 unspecified");
    });

    it("should detect link-local fe80::/10 addresses as private", () => {
      console.log("[SSRF TEST] Checking IPv6 link-local");
      assert.equal(isPrivateIP("fe80::1"), true, "fe80::1 is link-local");
      assert.equal(isPrivateIP("fe80::abcd:ef01:2345:6789"), true, "fe80::abcd:ef01:2345:6789 is link-local");
    });

    it("should detect ULA fc00::/7 addresses as private", () => {
      console.log("[SSRF TEST] Checking IPv6 ULA");
      assert.equal(isPrivateIP("fc00::1"), true, "fc00::1 is ULA");
      assert.equal(isPrivateIP("fd12::1"), true, "fd12::1 is ULA");
      assert.equal(isPrivateIP("fdff::1"), true, "fdff::1 is ULA");
    });

    it("should detect IPv4-mapped IPv6 addresses correctly", () => {
      console.log("[SSRF TEST] Checking IPv4-mapped IPv6 addresses");
      assert.equal(isPrivateIP("::ffff:192.168.1.1"), true, "::ffff:192.168.1.1 maps to private IPv4");
      assert.equal(isPrivateIP("::ffff:10.0.0.1"), true, "::ffff:10.0.0.1 maps to private IPv4");
      assert.equal(isPrivateIP("::ffff:127.0.0.1"), true, "::ffff:127.0.0.1 maps to loopback IPv4");
      assert.equal(isPrivateIP("::ffff:8.8.8.8"), false, "::ffff:8.8.8.8 maps to public IPv4");
      assert.equal(isPrivateIP("::ffff:1.1.1.1"), false, "::ffff:1.1.1.1 maps to public IPv4");
    });

    it("should allow public IPv6 addresses", () => {
      console.log("[SSRF TEST] Checking public IPv6 addresses");
      assert.equal(isPrivateIP("2001:4860:4860::8888"), false, "Google Public DNS IPv6 is public");
      assert.equal(isPrivateIP("2606:4700:4700::1111"), false, "Cloudflare DNS IPv6 is public");
    });
  });
});

// =============================================================================
// checkHostSafety
// =============================================================================

describe("checkHostSafety", () => {
  it("should reject direct private IPv4 addresses", async () => {
    console.log("[SSRF TEST] checkHostSafety with private IPv4");
    const result = await checkHostSafety("127.0.0.1");
    assert.equal(result.safe, false, "127.0.0.1 should be unsafe");
    assert.ok("reason" in result && result.reason.includes("private"), "reason should mention private");
  });

  it("should reject direct private IPv4 in RFC 1918 ranges", async () => {
    console.log("[SSRF TEST] checkHostSafety with RFC 1918 addresses");
    const result10 = await checkHostSafety("10.0.0.1");
    assert.equal(result10.safe, false, "10.0.0.1 should be unsafe");

    const result192 = await checkHostSafety("192.168.1.1");
    assert.equal(result192.safe, false, "192.168.1.1 should be unsafe");
  });

  it("should allow direct public IPv4 addresses", async () => {
    console.log("[SSRF TEST] checkHostSafety with public IPv4");
    const result = await checkHostSafety("8.8.8.8");
    assert.equal(result.safe, true, "8.8.8.8 should be safe");
    assert.ok("ip" in result && result.ip === "8.8.8.8", "should return the IP");
  });

  it("should reject direct private IPv6 addresses", async () => {
    console.log("[SSRF TEST] checkHostSafety with private IPv6");
    const result = await checkHostSafety("::1");
    assert.equal(result.safe, false, "::1 should be unsafe");
  });

  it("should reject hostname 'localhost' which resolves to a private IP", async () => {
    console.log("[SSRF TEST] checkHostSafety with localhost hostname");
    const result = await checkHostSafety("localhost");
    assert.equal(result.safe, false, "localhost should be unsafe");
    assert.ok("reason" in result, "should provide a reason");
  });

  it("should return safe:false when DNS resolution fails", async () => {
    console.log("[SSRF TEST] checkHostSafety with non-existent domain");
    const result = await checkHostSafety("this-domain-definitely-does-not-exist-xyzzy-12345.invalid");
    assert.equal(result.safe, false, "unresolvable domain should be unsafe");
    assert.ok(
      "reason" in result && result.reason.includes("Failed to resolve"),
      "reason should mention resolution failure",
    );
  });

  it("should return safe:true with resolved ip for a known public hostname", async () => {
    console.log("[SSRF TEST] checkHostSafety with a public hostname (dns.google)");
    // dns.google is Google's well-known DNS hostname that resolves to 8.8.8.8 / 8.8.4.4
    const result = await checkHostSafety("dns.google");
    assert.equal(result.safe, true, "dns.google should be safe");
    assert.ok("ip" in result && typeof result.ip === "string", "should return the resolved IP");
  });
});

// =============================================================================
// canonicalizeUrl
// =============================================================================

describe("canonicalizeUrl", () => {
  it("should lowercase the host", () => {
    console.log("[SSRF TEST] canonicalizeUrl host lowercasing");
    const result = canonicalizeUrl("HTTP://EXAMPLE.COM/path");
    assert.ok(result.includes("example.com"), "host should be lowercased");
    assert.ok(result.startsWith("http://"), "scheme should be lowercased");
  });

  it("should remove default port 443 for https", () => {
    console.log("[SSRF TEST] canonicalizeUrl default port removal (https:443)");
    const result = canonicalizeUrl("https://example.com:443/path");
    assert.equal(result, "https://example.com/path", "port 443 should be removed for https");
  });

  it("should remove default port 80 for http", () => {
    console.log("[SSRF TEST] canonicalizeUrl default port removal (http:80)");
    const result = canonicalizeUrl("http://example.com:80/path");
    assert.equal(result, "http://example.com/path", "port 80 should be removed for http");
  });

  it("should keep non-default ports", () => {
    console.log("[SSRF TEST] canonicalizeUrl non-default port preservation");
    const result = canonicalizeUrl("https://example.com:8443/path");
    assert.ok(result.includes(":8443"), "non-default port should be preserved");
  });

  it("should throw on path traversal sequences", () => {
    console.log("[SSRF TEST] canonicalizeUrl path traversal detection");
    assert.throws(
      () => canonicalizeUrl("http://example.com/path/..%2Fadmin"),
      { message: /path traversal/i },
      "should throw on encoded path traversal",
    );
  });

  it("should resolve percent-encoded dot-dot traversal via URL constructor normalization", () => {
    console.log("[SSRF TEST] canonicalizeUrl percent-encoded dot-dot resolution");
    // The WHATWG URL spec treats %2e%2e as equivalent to .. during path parsing
    // So the URL constructor resolves it: /path/%2e%2e/admin → /admin
    // This is safe because the traversal is normalized away, not bypassed
    const result = canonicalizeUrl("http://example.com/path/%2e%2e/admin");
    assert.ok(!result.includes(".."), "path traversal should be resolved by URL constructor");
    assert.ok(result.includes("/admin"), "resolved path should contain /admin");
  });

  it("should apply Unicode NFC normalization", () => {
    console.log("[SSRF TEST] canonicalizeUrl Unicode NFC normalization");
    // U+00E9 (e-acute precomposed) vs U+0065 U+0301 (e + combining acute)
    // NFC should normalize the decomposed form to the precomposed form
    const precomposed = "https://example.com/caf\u00E9";
    const decomposed = "https://example.com/cafe\u0301";
    const resultPre = canonicalizeUrl(precomposed);
    const resultDec = canonicalizeUrl(decomposed);
    assert.equal(resultPre, resultDec, "NFC normalization should make both forms identical");
  });

  it("should preserve query strings", () => {
    console.log("[SSRF TEST] canonicalizeUrl query string preservation");
    const result = canonicalizeUrl("https://example.com/path?key=value&foo=bar");
    assert.ok(result.includes("?key=value&foo=bar"), "query string should be preserved");
  });

  it("should throw on invalid URLs", () => {
    console.log("[SSRF TEST] canonicalizeUrl invalid URL");
    assert.throws(
      () => canonicalizeUrl("not-a-url"),
      "should throw on invalid URL",
    );
  });
});

// =============================================================================
// Constants
// =============================================================================

describe("SSRF Protection Constants", () => {
  it("should export expected default values", () => {
    console.log("[SSRF TEST] Verifying exported constants");
    assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 60_000, "timeout should be 60s");
    assert.equal(DEFAULT_MAX_PAYLOAD_SIZE_BYTES, 10 * 1024 * 1024, "max payload should be 10 MB");
    assert.equal(DEFAULT_MAX_RESPONSE_SIZE_BYTES, 10 * 1024 * 1024, "max response should be 10 MB");
    // Also verify the raw numeric values
    assert.equal(DEFAULT_MAX_PAYLOAD_SIZE_BYTES, 10_485_760, "max payload is 10485760 bytes");
    assert.equal(DEFAULT_MAX_RESPONSE_SIZE_BYTES, 10_485_760, "max response is 10485760 bytes");
  });
});
