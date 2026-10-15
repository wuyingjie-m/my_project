import { runSelfImprovementCommand } from "../self-improvement-command";

export async function POST(request: Request) {
  return runSelfImprovementCommand("weekly-review" as any, request);
}
