/**
 * The judge's command line.
 *
 *   npm run judge -- serve              start the HTTP service
 *   npm run judge -- once <id> <file>   judge one task from a local file, then exit
 *   npm run judge -- check              print the configuration (no secrets) and the mode
 *
 * Configuration is read from the environment; see .env.example.
 */

import { readFile } from "node:fs/promises";
import { buildJudge, loadConfig } from "./config.js";
import { createJudgeServer } from "./server.js";

function usage(): never {
  console.error("usage: judge serve | judge once <taskId> <file> | judge check");
  process.exit(2);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();

  const config = loadConfig();
  const built = buildJudge(config);

  if (command === "check") {
    console.log(JSON.stringify(built.info, null, 2));
    return;
  }

  if (command === "once") {
    const [taskId, file] = args;
    if (!taskId || !file) usage();
    const content = await readFile(file, "utf8");
    const outcome = await built.judge.judgeTask(taskId, content);
    console.log(JSON.stringify(outcome, null, 2));
    process.exit(outcome.status === "settled" || outcome.status === "held" ? 0 : 1);
  }

  if (command === "serve") {
    const server = createJudgeServer(built);
    server.listen(config.port, () => {
      console.log(`Rubric judge (${built.info.mode}, ${built.info.model}) for ${config.contractId} listening on :${config.port}`);
      if (config.mode === "mock") {
        console.log("MOCK MODE: an offline rule, not a language model. Set JUDGE_MODE=near-ai and NEAR_AI_API_KEY for the real judge.");
      }
    });
    return;
  }

  usage();
}

main().catch((error: unknown) => {
  // The message only: a stack or a cause can carry a URL or a header.
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
});
