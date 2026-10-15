import { runSelfImprovementCommand } from "../self-improvement-command";

export async function POST(request: Request) {
  return runSelfImprovementCommand("ingest-usage" as any, request);
}
