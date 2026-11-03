import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ScenarioResult } from "./scenario.js";
import { mergeSnapshots } from "./snapshot.js";

/** Print a scenario's receipts and its checks, and return whether every check passed. */
export function report(result: ScenarioResult, print: (line: string) => void = console.log): boolean {
  print("\nRECEIPTS\n" + result.table);
  print("\nCHECKS (against the chain, not against what the agents said)");
  for (const c of result.checks) print(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}\n        ${c.detail}`);
  print(`\n${result.ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
  return result.ok;
}

/**
 * Write the dashboard's snapshot, only from a run that passed. If the file already holds a snapshot
 * of the same contract, the new run is added to it rather than replacing it.
 */
export async function exportSnapshot(result: ScenarioResult, path: string | undefined, print: (line: string) => void = console.log): Promise<void> {
  const target = path?.trim();
  if (!target) return;
  if (!result.ok) {
    print("snapshot NOT written: the run did not pass its checks");
    return;
  }

  let existing: unknown = null;
  try {
    existing = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") print(`${target} could not be read as a snapshot, so it will be replaced`);
  }
  const merged = mergeSnapshots(existing, result.snapshot);
  const added = Object.keys(result.snapshot.tasks).length;
  const kept = Object.keys(merged.tasks).length - added;

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  print(`snapshot written to ${target}: ${added} task${added === 1 ? "" : "s"} from this run${kept > 0 ? `, ${kept} kept from earlier runs` : ""}`);
}
