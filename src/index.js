import "dotenv/config";

import { runPipeline } from "./pipeline.js";

async function main() {
  const args = process.argv.slice(2);
  const useMock = args.includes("--mock");

  await runPipeline({ useMock });
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exitCode = 1;
});
