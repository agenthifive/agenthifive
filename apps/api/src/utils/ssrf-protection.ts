import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

/**
 * Private and reserved IP ranges that should be blocked to prevent SSRF attacks.
 * Based on RFC 1918, RFC 4193, RFC 5737, RFC 6598, RFC 6890.
 */
const PRIVATE_IPV4_RANGES: Array<{ prefix: number[]; mask: number }> = [
  { prefix: [10], mask: 8 },            // 10.0.0.0/8 - Private
  { prefix: [172, 16], mask: 12 },       // 172.16.0.0/12 - Private
  { prefix: [192, 168], mask: 16 },      // 192.168.0.0/16 - Private
  { prefix: [127], mask: 8 },            // 127.0.0.0/8 - Loopback
  { prefix: [169, 254], mask: 16 },      // 169.254.0.0/16 - Link-local
  { prefix: [0], mask: 8 },              // 0.0.0.0/8 - "This" network
  { prefix: [100, 64], mask: 10 },       // 100.64.0.0/10 - Carrier-grade NAT
  { prefix: [192, 0, 0], mask: 24 },     // 192.0.0.0/24 - IETF Protocol Assignments
  { prefix: [192, 0, 2], mask: 24 },     // 192.0.2.0/24 - Documentation (TEST-NET-1)
  { prefix: [198, 51, 100], mask: 24 },  // 198.51.100.0/24 - Documentation (TEST-NET-2)
  { prefix: [203, 0, 113], mask: 24 },   // 203.0.113.0/24 - Documentation (TEST-NET-3)
  { prefix: [198, 18], mask: 15 },       // 198.18.0.0/15 - Benchmarking
  { prefix: [224], mask: 4 },            // 224.0.0.0/4 - Multicast
  { prefix: [240], mask: 4 },            // 240.0.0.0/4 - Reserved
  { prefix: [255, 255, 255, 255], mask: 32 }, // 255.255.255.255/32 - Broadcast
];

function parseIPv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function ipv4ToNumber(octets: number[]): number {
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

function prefixToNumber(prefix: number[]): number {
  const padded = [...prefix, 0, 0, 0, 0].slice(0, 4);
  return ((padded[0]! << 24) | (padded[1]! << 16) | (padded[2]! << 8) | padded[3]!) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const octets = parseIPv4Octets(ip);
  if (!octets) return false;

  const ipNum = ipv4ToNumber(octets);

  for (const range of PRIVATE_IPV4_RANGES) {
    const mask = (0xFFFFFFFF << (32 - range.mask)) >>> 0;
    const rangeStart = prefixToNumber(range.prefix);
    if ((ipNum & mask) === (rangeStart & mask)) {
      return true;
    }
  }
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  // ::1 - Loopback
  if (normalized === "::1" || normalized === "0000:0000:0000:0000:0000:0000:0000:0001") return true;
  // :: - Unspecified
  if (normalized === "::") return true;
  // fe80::/10 - Link-local
  if (normalized.startsWith("fe80:") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  // fc00::/7 - Unique local (ULA)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  // ::ffff:0:0/96 - IPv4-mapped IPv6 (check the IPv4 part)
  if (normalized.startsWith("::ffff:")) {
    const ipv4Part = normalized.slice(7);
    if (isIPv4(ipv4Part)) {
      return isPrivateIPv4(ipv4Part);
    }
  }
  return false;
}

/**
 * Check if an IP address belongs to a private or reserved range.
 */
export function isPrivateIP(ip: string): boolean {
  if (isIPv4(ip)) return isPrivateIPv4(ip);
  if (isIPv6(ip)) return isPrivateIPv6(ip);
  return false;
}

/**
 * Hostnames explicitly allowed to bypass private-IP SSRF checks.
 * Used in integration/e2e testing where Docker internal hostnames (e.g., "echo")
 * resolve to private IPs. Never set in production.
 */
const SSRF_ALLOWLIST_HOSTS = new Set(
  (process.env["SSRF_ALLOWLIST_HOSTS"] ?? "").split(",").filter(Boolean),
);

/**
 * Resolve a hostname and check if it resolves to a private IP address.
 * Returns { safe: true } if the hostname resolves to a public IP,
 * or { safe: false, reason: string } if it resolves to a private IP or fails to resolve.
 */
export async function checkHostSafety(
  hostname: string,
): Promise<{ safe: true; ip: string } | { safe: false; reason: string }> {
  // Allowlisted hostnames bypass private-IP checks (testing only)
  if (SSRF_ALLOWLIST_HOSTS.has(hostname)) {
    try {
      const result = await lookup(hostname, { family: 0 });
      return { safe: true, ip: result.address };
    } catch {
      return { safe: false, reason: `Failed to resolve allowlisted hostname: ${hostname}` };
    }
  }

  // Direct IP address check (no DNS needed)
  if (isIPv4(hostname) || isIPv6(hostname)) {
    if (isPrivateIP(hostname)) {
      return { safe: false, reason: `Blocked: request to private IP address ${hostname}` };
    }
    return { safe: true, ip: hostname };
  }

  // Resolve hostname to IP
  try {
    const result = await lookup(hostname, { family: 0 }); // resolve both IPv4 and IPv6
    if (isPrivateIP(result.address)) {
      return { safe: false, reason: `Blocked: hostname ${hostname} resolves to private IP ${result.address}` };
    }
    return { safe: true, ip: result.address };
  } catch {
    return { safe: false, reason: `Failed to resolve hostname: ${hostname}` };
  }
}

/**
 * Canonicalize a URL to prevent bypass via encoding tricks.
 * - Decodes and re-encodes percent-encoding
 * - Normalizes unicode (NFC)
 * - Resolves dot segments (/../, /./)
 * - Normalizes scheme and host to lowercase
 * - Removes default ports
 */
export function canonicalizeUrl(rawUrl: string): string {
  // Normalize unicode
  const normalized = rawUrl.normalize("NFC");

  // Parse URL — this handles percent-decoding and normalization
  const parsed = new URL(normalized);

  // The URL constructor already:
  // - Lowercases the scheme and host
  // - Resolves dot segments (/../, /./)
  // - Normalizes percent encoding
  // - Removes default ports (80 for http, 443 for https)

  // Double-decode check: decode the path once more to catch double-encoding
  // e.g., %252F -> %2F -> / (bypassing path-based allowlists)
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    // If decoding fails, the URL is already properly normalized
    decodedPath = parsed.pathname;
  }

  // Check for path traversal after decoding
  if (decodedPath.includes("..")) {
    throw new Error("URL contains path traversal sequences");
  }

  // Re-encode the path segments properly.
  // encodeURIComponent is too aggressive for path segments — it encodes
  // characters like : @ ! $ ' ( ) * + , ; which are allowed in paths per
  // RFC 3986. We decode them back to preserve valid API URLs like
  // /v1/documents/{id}:batchUpdate (Google APIs use colons in paths).
  const cleanPath = decodedPath
    .split("/")
    .map((segment) =>
      encodeURIComponent(decodeURIComponent(segment))
        .replace(/%3A/gi, ":")
        .replace(/%40/gi, "@")
        .replace(/%21/gi, "!")
        .replace(/%24/gi, "$")
        .replace(/%27/gi, "'")
        .replace(/%28/gi, "(")
        .replace(/%29/gi, ")")
        .replace(/%2A/gi, "*")
        .replace(/%2B/gi, "+")
        .replace(/%2C/gi, ",")
        .replace(/%3B/gi, ";"),
    )
    .join("/");

  // Reconstruct the URL with the canonical path
  parsed.pathname = cleanPath;

  return parsed.toString();
}

/**
 * Default safety limits for Model B proxy requests.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_PAYLOAD_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const DEFAULT_MAX_RESPONSE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
