import { runSelfImprovementCommand } from "../self-improvement-command";

export async function POST(request: Request) {
  return runSelfImprovementCommand("dry-run" as any, request);
}
