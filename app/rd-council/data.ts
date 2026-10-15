export {}; // Empty export to treat this as a module

type Stage = "trending" | "opportunity" | "council";
type OriginType = "reactive" | "proactive";
type ProactiveLens = "efficiency" | "infrastructure" | "pattern" | "external" | null;
type CouncilConfidence = "high" | "medium" | "low";
type EscalationType = "auto" | "manual";
type SessionType = "scheduled" | "emergency";
type TimeOfDay = "morning" | "evening";
type Decision = null | "approved" | "rejected" | "snoozed";

interface CouncilItem {
  id: string;
  title: string;
  summary: string;
  created_at: string;
  stage: Stage;
  council_session_id: string;
  promotion_reason: string;
  proposing_model: string;
  origin_type: OriginType;
  origin_tags: string[];
  proactive_lens: ProactiveLens;
  idea_ledger_id: string;
  council_confidence: CouncilConfidence;
  debate_summary: string[];
  key_disagreements: { model: string; concern: string; resolution: string }[];
  council_recommendation: string;
  passing_reasoning: string;
  escalation_type: EscalationType;
  session_type: SessionType;
  scheduled_for: string;
  session_time_of_day: TimeOfDay;
  decision: Decision;
  decision_note?: string;
  decision_at?: string;
  snooze_until?: string;
  is_hidden: boolean;
  hidden_until?: string;
}

const mockedItems: CouncilItem[] = [
  {
    id: "rdc-001",
    title: "SaaS Pricing Tier Optimization",
    summary: "Data shows 23% of free-tier users upgrade when premium features are unlocked via API integrations",
    created_at: "2026-03-24T14:30:00Z",
    stage: "council",
    council_session_id: "session-morning-2026-03-24",
    promotion_reason: "Multiple mentions across 3+ sessions with high signal strength",
    proposing_model: "llama-3.1-70b",
    origin_type: "reactive",
    origin_tags: ["📊 Reactive Analysis"],
    proactive_lens: null,
    idea_ledger_id: "ledger-reactive-001",
    council_confidence: "high",
    debate_summary: [
      "Model A: Pricing tiers should align with feature adoption patterns",
      "Model B: Free tier users need more engagement triggers before upgrade",
      "Model C: API integration unlock point is too high —降低 barrier"
    ],
    key_disagreements: [
      { model: "llama-3.1-70b", concern: "Free tier users need more engagement triggers", resolution: "Added engagement score threshold" },
      { model: "deepseek-v3", concern: "API unlocks too high", resolution: "Lowered unlock threshold from 5 to 3 features" }
    ],
    council_recommendation: "Implement API-integration unlock tracking withengagement score thresholds. Free tier users who interact with3+ premium features via API should see upgrade prompts.",
    passing_reasoning: "Met all criteria: clear data signal, actionable recommendation, supported by 4 of 5 models",
    escalation_type: "auto",
    session_type: "scheduled",
    scheduled_for: "2026-03-24T09:00:00Z",
    session_time_of_day: "morning",
    decision: null,
    is_hidden: false
  },
  {
    id: "rdc-002",
    title: "Mobile App Feature Prioritization",
    summary: "User session data indicates 40% drop-off at onboarding step 3",
    created_at: "2026-03-25T08:15:00Z",
    stage: "council",
    council_session_id: "session-morning-2026-03-25",
    promotion_reason: "Sustained signal across 2 consecutive sessions",
    proposing_model: "claude-sonnet-4-6",
    origin_type: "reactive",
    origin_tags: ["🔍 Pattern Detected"],
    proactive_lens: null,
    idea_ledger_id: "ledger-reactive-002",
    council_confidence: "medium",
    debate_summary: [
      "Model A: Simplify onboarding flow — reduce to 2 steps",
      "Model B: Add intermediate progress indicator instead",
      "Model C: A/B test both approaches simultaneously"
    ],
    key_disagreements: [
      { model: "claude-sonnet-4-6", concern: "Progress indicator may confuse users", resolution: "Added on-screen guidance text" },
      { model: "gemini-ultra", concern: "Too many changes at once", resolution: "Pilot with 10% of new users first" }
    ],
    council_recommendation: "Deploy simplified onboarding flow (2 steps) to 50% of new users. Add progress indicator variant toA/B test with existing 50%.",
    passing_reasoning: "Actionable, measurable, supported by 3 models with clear testing plan",
    escalation_type: "auto",
    session_type: "scheduled",
    scheduled_for: "2026-03-25T09:00:00Z",
    session_time_of_day: "morning",
    decision: null,
    is_hidden: false
  },
  {
    id: "rdc-003",
    title: "Template Generator for New Projects",
    summary: "You create same project structure repeatedly — build automated template generator",
    created_at: "2026-03-25T09:00:00Z",
    stage: "trending",
    council_session_id: "session-morning-2026-03-25-proactive",
    promotion_reason: "First proactive idea from today's council session",
    proposing_model: "deepseek-v3",
    origin_type: "proactive",
    origin_tags: ["⚙️ Efficiency Gap"],
    proactive_lens: "efficiency",
    idea_ledger_id: "ledger-proactive-001",
    council_confidence: "high",
    debate_summary: [
      "Devil's Advocate: Current project structures vary too much for templates",
      "Resource Check: 2-3 days to build CLI tool, minimal maintenance",
      "Impact Estimator: 50% time savings on new project setup",
      "Timing Analyst: Market slow, perfect time for infrastructure work"
    ],
    key_disagreements: [
      { model: "claude-sonnet-4-6", concern: "Projects vary too much for templates", resolution: "Add flexible template variables and presets" },
      { model: "llama-3.1-70b", concern: "Requires CLI learning curve", resolution: "Build UI wrapper with preset library" }
    ],
    council_recommendation: "Build CLI template generator with flexible variables. Add preset library (Next.js, Remix, FastAPI, etc).",
    passing_reasoning: "Clear ROI, minimal risk, matches current project patterns",
    escalation_type: "auto",
    session_type: "scheduled",
    scheduled_for: "2026-03-25T17:00:00Z",
    session_time_of_day: "evening",
    decision: null,
    is_hidden: false
  },
  {
    id: "rdc-004",
    title: "Client-Facing Status Page",
    summary: "No central status page — clients ask for updates manually via email",
    created_at: "2026-03-25T09:00:00Z",
    stage: "opportunity",
    council_session_id: "session-morning-2026-03-25-proactive",
    promotion_reason: "Proactive infrastructure idea promoted by council",
    proposing_model: "gemini-ultra",
    origin_type: "proactive",
    origin_tags: ["🏗️ Infrastructure Idea"],
    proactive_lens: "infrastructure",
    idea_ledger_id: "ledger-proactive-002",
    council_confidence: "medium",
    debate_summary: [
      "Devil's Advocate: Status pages often become outdated and damage trust",
      "Resource Check: 1 week with Stripe Status clone, 40hr/mo maintenance",
      "Impact Estimator: 30% support ticket reduction, faster deal velocity",
      "Timing Analyst: Q2 roadmap light, good window for feature dev"
    ],
    key_disagreements: [
      { model: "claude-sonnet-4-6", concern: "Status pages become outdated", resolution: "Auto-sync with GitHub issues, manual override only" },
      { model: "deepseek-v3", concern: "Maintenance burden", resolution: "Start with read-only status on docs site, upgrade later" }
    ],
    council_recommendation: "Deploy read-only status page on docs.flobase.ai, sync with GitHub issues. Start with Q2 projects only.",
    passing_reasoning: "Low-risk MVP, clear business impact, addresses recurring client pain point",
    escalation_type: "auto",
    session_type: "scheduled",
    scheduled_for: "2026-03-25T17:00:00Z",
    session_time_of_day: "evening",
    decision: null,
    is_hidden: false
  },
  // Ingested from usage analysis
  {
    id: "rdc-ingest-001",
    title: "OpenClaw Model Routing Optimization",
    summary: "Frequent requests for model selection suggest need for smarter auto-routing based on task complexity",
    created_at: "2026-03-25T23:36:37.974Z",
    stage: "trending",
    council_session_id: "auto-ingestion",
    promotion_reason: "Detected from usage pattern analysis",
    proposing_model: "ollama-cloud/qwen3.5:397b-cloud",
    origin_type: "proactive",
    origin_tags: ["⚙️ Efficiency Gap", "🔍 Pattern Detected"],
    proactive_lens: "pattern",
    idea_ledger_id: "ledger-ingest-001",
    council_confidence: "medium",
    debate_summary: [
      "Devil's Advocate: Current model routing works, optimization is marginal",
      "Resource Check: 1 day to implement smart routing logic",
      "Impact Estimator: 15% reduction in token waste",
      "Timing Analyst: Q2 roadmap allows for optimization work"
    ],
    key_disagreements: [
      { model: "claude-sonnet-4-6", concern: "Current routing works", resolution: "Add gradual rollout with A/B testing" },
      { model: "llama-3.1-70b", concern: "Token savings small", resolution: "Focus on cost reduction for scale" }
    ],
    council_recommendation: "Implement intelligent model routing based on task complexity detected from session logs. Start with A/B test.",
    passing_reasoning: "Clear optimization path, measurable cost impact, low implementation risk",
    escalation_type: "auto",
    session_type: "scheduled",
    scheduled_for: "2026-03-25T17:00:00Z",
    session_time_of_day: "evening",
    decision: null,
    is_hidden: false
  },
  {
    id: "rdc-ingest-002",
    title: "Telegram Webhook Integration",
    summary: "Multiple Telegram interactions indicate opportunity for better webhook handling and async message processing",
    created_at: "2026-03-25T23:36:37.974Z",
    stage: "trending",
    council_session_id: "auto-ingestion",
    promotion_reason: "Detected from usage pattern analysis",
    proposing_model: "ollama-cloud/qwen3.5:397b-cloud",
    origin_type: "proactive",
    origin_tags: ["⚙️ Efficiency Gap", "🏗️ Infrastructure Idea"],
    proactive_lens: "infrastructure",
    idea_ledger_id: "ledger-ingest-002",
    council_confidence: "medium",
    debate_summary: [
      "Devil's Advocate: Telegram integration works, webhook changes aren't urgent",
      "Resource Check: 3 days to implement async webhook processor",
      "Impact Estimator: 20% faster Telegram response times",
      "Timing Analyst: Good time before peak season"
    ],
    key_disagreements: [
      { model: "deepseek-v3", concern: "Not urgent", resolution: "Add to Q2 backlog" },
      { model: "gemini-ultra", concern: "Complex async architecture", resolution: "Start with simple queue buffering" }
    ],
    council_recommendation: "Build async webhook processing layer with Redis queue buffer. Add dead-letter queue for failed messages.",
    passing_reasoning: "High ROI on response times, handles current traffic volume, scalable architecture",
    escalation_type: "auto",
    session_type: "scheduled",
    scheduled_for: "2026-03-25T17:00:00Z",
    session_time_of_day: "evening",
    decision: null,
    is_hidden: false
  },
  {
    id: "rdc-ingest-003",
    title: "Docker Deployment Pipeline",
    summary: "Repeated Docker build requests suggest need for automated CI/CD pipeline integration",
    created_at: "2026-03-25T23:36:37.974Z",
    stage: "opportunity",
    council_session_id: "auto-ingestion",
    promotion_reason: "Detected from usage pattern analysis - Docker builds recurring",
    proposing_model: "ollama-cloud/qwen3.5:397b-cloud",
    origin_type: "proactive",
    origin_tags: ["⚙️ Efficiency Gap", "🏗️ Infrastructure Idea"],
    proactive_lens: "efficiency",
    idea_ledger_id: "ledger-ingest-003",
    council_confidence: "high",
    debate_summary: [
      "Devil's Advocate: Manual Docker builds work, CI/CD may be overkill",
      "Resource Check: 1 week to set up GitHub Actions workflow",
      "Impact Estimator: 4 hours/week saved on deployment",
      "Timing Analyst: Perfect for pre-production work"
    ],
    key_disagreements: [
      { model: "claude-sonnet-4-6", concern: "Overkill for current scale", resolution: "Start with basic push-to-registry workflow" },
      { model: "llama-3.1-70b", concern: "Security concerns", resolution: "Add approval gates for production pushes" }
    ],
    council_recommendation: "Build GitHub Actions CI/CD pipeline for Docker builds with approval gates for production. Add artifact registry.",
    passing_reasoning: "Clear time savings, handles current workflow, security-aware architecture",
    escalation_type: "auto",
    session_type: "scheduled",
    scheduled_for: "2026-03-25T17:00:00Z",
    session_time_of_day: "evening",
    decision: null,
    is_hidden: false
  },
  {
    id: "rdc-ingest-004",
    title: "Self-Improvement Automation",
    summary: "Dashboard updates require frequent redeploy - automate with GitHub Actions workflow",
    created_at: "2026-03-25T23:36:37.974Z",
    stage: "opportunity",
    council_session_id: "auto-ingestion",
    promotion_reason: "Detected from usage pattern analysis - frequent redeploy requests",
    proposing_model: "ollama-cloud/qwen3.5:397b-cloud",
    origin_type: "proactive",
    origin_tags: ["⚙️ Efficiency Gap", "🏗️ Infrastructure Idea"],
    proactive_lens: "infrastructure",
    idea_ledger_id: "ledger-ingest-004",
    council_confidence: "high",
    debate_summary: [
      "Devil's Advocate: Manual redeploy is quick, automation complexity may not be worth it",
      "Resource Check: 2 days to configure GitHub Actions with Docker cache",
      "Impact Estimator: 30 minutes/week saved on deployment",
      "Timing Analyst: Excellent timing with current dashboard development"
    ],
    key_disagreements: [
      { model: "gemini-ultra", concern: "Manual redeploy is simple", resolution: "Add one-click redeploy button first, then automate" },
      { model: "deepseek-v3", concern: "CI/CD setup complexity", resolution: "Use pre-built Docker images for faster pushes" }
    ],
    council_recommendation: "Add GitHub Actions workflow that builds and deploys to Vercel on push to main branch. Cache Docker layers for speed.",
    passing_reasoning: "Minimal setup complexity, significant time savings, proven CI/CD pattern",
    escalation_type: "auto",
    session_type: "scheduled",
    scheduled_for: "2026-03-25T17:00:00Z",
    session_time_of_day: "evening",
    decision: null,
    is_hidden: false
  }
];

export { mockedItems };
