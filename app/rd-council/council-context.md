# Council Context - v1.1

## Council Mode
- **Reactive Mode**: Analyzes your current work and recommends next steps
- **Proactive Mode**: Ignores current work, asks "what should I be doing?"

## Proactive Lenses (4 per session)
Each model must surface at least one proactive idea from these lenses:

1. **Efficiency**: What could be automated? What takes too long? What gets repeated?
2. **Infrastructure**: What foundational system would unlock 3+ things?
3. **Pattern**: What keeps getting built pieces without finishing the full version?
4. **External**: What's the market rewarding right now?

## Idea Ledger Structure
```json
{
  "proposed": [],
  "adopted": [],
  "rejected": [],
  "dormant": []
}
```

## Debate Framework for Proactive Ideas
**Proposer opens with**: One idea from each of the 4 lenses

**Debate rounds**:
- **Model 1 (Devil's Advocate)**: Why this is a distraction right now
- **Model 2 (Resource Check)**: How long to build, what skills needed
- **Model 3 (Impact Estimator)**: Measurable outcome if built
- **Model 4 (Timing Analyst)**: Is now the right time?

**Proposer responds** to all 4 concerns before final vote

## Confidence Levels
- **Low**: Idea needs more research, not fully formed
- **Medium**: Clear concept, needs validation
- **High**: Strong evidence, ready for action

## Learning Rules
- Reject 3x same idea type → stop pitching that lens
- 2 approvals in same category → auto-promote to next lens
- Dormant ideas (snoozed) → re-evaluate with fresh context
