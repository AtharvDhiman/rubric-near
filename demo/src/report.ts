import type { ScenarioResult } from "./scenario.js";

/** Print a scenario's receipts and its checks, and return whether every check passed. */
export function report(result: ScenarioResult, print: (line: string) => void = console.log): boolean {
  print("\nRECEIPTS\n" + result.table);
  print("\nCHECKS (against the chain, not against what the agents said)");
  for (const c of result.checks) print(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}\n        ${c.detail}`);
  print(`\n${result.ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
  return result.ok;
}

/** Where, if anywhere, to write the dashboard's snapshot; only ever from a run that passed. */
export async function exportSnapshot(result: ScenarioResult, path: string | undefined, print: (line: string) => void = console.log): Promise<void> {
  const target = path?.trim();
  if (!target) return;
  if (!result.ok) {
    print("snapshot NOT written: the run did not pass its checks");
    return;
  }
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(result.snapshot, null, 2)}\n`, "utf8");
  print(`snapshot written to ${target}`);
}
