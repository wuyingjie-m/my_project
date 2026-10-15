import { runSelfImprovementCommand } from "../self-improvement-command";

export async function POST(request: Request) {
  return runSelfImprovementCommand("proactive-real" as any, request);
}
