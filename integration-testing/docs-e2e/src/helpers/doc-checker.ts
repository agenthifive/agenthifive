/**
 * Documentation Gap Reporter
 *
 * Collects issues found during docs-followability testing and prints
 * a structured report at the end.
 */

export type DocGapSeverity = "wrong" | "unclear" | "missing";

export interface DocGap {
  file: string;
  section: string;
  severity: DocGapSeverity;
  description: string;
  evidence: string;
}

const gaps: DocGap[] = [];

export function reportGap(gap: DocGap): void {
  gaps.push(gap);
  const icon =
    gap.severity === "wrong" ? "✗" : gap.severity === "missing" ? "?" : "~";
  console.log(
    `  [${icon}] ${gap.severity.toUpperCase()}: ${gap.file} — ${gap.section}`,
  );
  console.log(`      ${gap.description}`);
}

export function getGaps(): readonly DocGap[] {
  return gaps;
}

export function printReport(): void {
  console.log("\n" + "═".repeat(70));
  console.log("  DOCUMENTATION GAP REPORT");
  console.log("═".repeat(70) + "\n");

  if (gaps.length === 0) {
    console.log("  No documentation gaps found.\n");
    return;
  }

  const byFile = new Map<string, DocGap[]>();
  for (const gap of gaps) {
    const list = byFile.get(gap.file) ?? [];
    list.push(gap);
    byFile.set(gap.file, list);
  }

  for (const [file, fileGaps] of byFile) {
    console.log(`  ${file}`);
    for (const gap of fileGaps) {
      const icon =
        gap.severity === "wrong"
          ? "✗"
          : gap.severity === "missing"
            ? "?"
            : "~";
      console.log(`    [${icon}] ${gap.severity.toUpperCase()}: ${gap.section}`);
      console.log(`        ${gap.description}`);
      if (gap.evidence) {
        console.log(`        Evidence: ${gap.evidence}`);
      }
    }
    console.log();
  }

  const counts = { wrong: 0, unclear: 0, missing: 0 };
  for (const gap of gaps) counts[gap.severity]++;
  console.log(
    `  Total: ${gaps.length} gaps (${counts.wrong} wrong, ${counts.unclear} unclear, ${counts.missing} missing)`,
  );
  console.log();
}
