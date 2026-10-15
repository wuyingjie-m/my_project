import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('../lib/self-improvement-data.mjs');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test('buildCouncilDeliberation returns deterministic multi-role council output', () => {
  const deliberation = mod.buildCouncilDeliberation({
    title: 'Docker Deployment Pipeline',
    summary: 'Repeated build/deploy signals suggest a repo-specific CI/CD pipeline with caching and approval gates.',
    proactive_lens: 'efficiency',
    evidence: [
      'docker build deployment pipeline repeated',
      'build deploy cache approval gate',
      'docker registry deploy workflow',
    ],
  });

  assert.deepEqual(
    deliberation.roles.map((role) => role.role),
    ['proposer', 'skeptic', 'cost_risk_reviewer', 'implementation_planner', 'final_recommendation']
  );
  assert.ok(deliberation.roles.every((role) => role.summary));
  assert.ok(deliberation.roles.every((role) => Array.isArray(role.points) && role.points.length > 0));
  assert.ok(Array.isArray(deliberation.key_disagreements) && deliberation.key_disagreements.length > 0);
  assert.ok(['high', 'medium', 'low'].includes(deliberation.confidence));
  assert.match(deliberation.recommendation, /pipeline|workflow|deploy/i);
  assert.match(deliberation.passing_reasoning, /confidence|signal|evidence/i);
  assert.ok(Array.isArray(deliberation.debate_summary) && deliberation.debate_summary.length >= 5);
});

test('buildEvidenceTelemetry scores recurrence, source ids, and stale-signal decay deterministically', () => {
  const telemetry = mod.buildEvidenceTelemetry({
    title: 'Docker Deployment Pipeline',
    evidence: [
      'docker build deployment pipeline repeated',
      'build deploy cache approval gate',
    ],
    sourceIds: ['session-1', 'session-2'],
    recurrenceCount: 5,
    timestamps: ['2026-04-30T09:00:00.000Z', '2026-04-20T09:00:00.000Z'],
    now: '2026-04-30T12:00:00.000Z',
  });

  assert.deepEqual(telemetry.evidence_snippets, [
    'docker build deployment pipeline repeated',
    'build deploy cache approval gate',
  ]);
  assert.deepEqual(telemetry.source_ids, ['session-1', 'session-2']);
  assert.equal(telemetry.recurrence_count, 5);
  assert.equal(telemetry.most_recent_at, '2026-04-30T09:00:00.000Z');
  assert.equal(telemetry.oldest_at, '2026-04-20T09:00:00.000Z');
  assert.equal(telemetry.staleness_days, 0);
  assert.equal(telemetry.stale_signal_decay, 1);
  assert.equal(telemetry.confidence_score, 0.933);
  assert.equal(telemetry.confidence_label, 'high');
});

test('buildCouncilItemsFromUsage returns complete schema with evidence-derived proactive metadata', () => {
  const sessions = {
    messages: [
      { id: 'msg-1', created_at: '2026-04-30T10:00:00.000Z', message: 'dashboard rebuild deploy build openclaw model routing' },
      { id: 'msg-2', created_at: '2026-04-29T09:00:00.000Z', message: 'telegram webhook manual response queue needed' },
      { id: 'msg-3', created_at: '2026-04-28T08:00:00.000Z', message: 'docker build deployment pipeline repeated' },
      { id: 'msg-4', created_at: '2026-03-01T08:00:00.000Z', message: 'self-improvement dashboard deploy automation' },
    ],
  };

  const items = mod.buildCouncilItemsFromUsage(sessions, { now: '2026-04-30T12:00:00.000Z' });

  assert.ok(items.length >= 4);
  for (const item of items) {
    assert.equal(item.origin_type, 'proactive');
    assert.ok(Array.isArray(item.origin_tags) && item.origin_tags.length > 0);
    assert.ok(['efficiency', 'infrastructure', 'pattern', 'external'].includes(item.proactive_lens));
    assert.ok(['high', 'medium', 'low'].includes(item.council_confidence));
    assert.deepEqual(
      item.deliberation.roles.map((role) => role.role),
      ['proposer', 'skeptic', 'cost_risk_reviewer', 'implementation_planner', 'final_recommendation']
    );
    assert.equal(item.council_confidence, item.deliberation.confidence);
    assert.ok(Array.isArray(item.debate_summary) && item.debate_summary.length > 0);
    assert.deepEqual(item.debate_summary, item.deliberation.debate_summary);
    assert.ok(Array.isArray(item.key_disagreements));
    assert.deepEqual(item.key_disagreements, item.deliberation.key_disagreements);
    assert.ok(item.council_recommendation);
    assert.equal(item.council_recommendation, item.deliberation.recommendation);
    assert.ok(item.passing_reasoning);
    assert.equal(item.passing_reasoning, item.deliberation.passing_reasoning);
    assert.ok(item.idea_ledger_id);
    assert.ok(item.evidence_telemetry);
    assert.ok(Array.isArray(item.evidence_telemetry.evidence_snippets));
    assert.ok(Array.isArray(item.evidence_telemetry.source_ids));
    assert.ok(item.evidence_telemetry.source_ids.length > 0);
    assert.ok(item.evidence_telemetry.recurrence_count >= 1);
    assert.ok(item.evidence_telemetry.confidence_score > 0);
    assert.ok(item.evidence_telemetry.stale_signal_decay > 0);
    assert.deepEqual(item.source_ids, item.evidence_telemetry.source_ids);
    assert.equal(item.recurrence_count, item.evidence_telemetry.recurrence_count);
    assert.equal(item.confidence_score, item.evidence_telemetry.confidence_score);
    assert.equal(item.stale_signal_decay, item.evidence_telemetry.stale_signal_decay);
  }

  const docker = items.find((item) => item.title === 'Docker Deployment Pipeline');
  assert.ok(docker);
  assert.deepEqual(docker.source_ids, ['msg-1', 'msg-3', 'msg-4']);
  assert.equal(docker.recurrence_count, 3);
  assert.equal(docker.evidence_telemetry.most_recent_at, '2026-04-30T10:00:00.000Z');
  assert.equal(docker.evidence_telemetry.staleness_days, 0);
  assert.equal(docker.council_confidence, docker.evidence_telemetry.confidence_label);
});

test('normalizeCouncilItem backfills deliberation for legacy-style records', () => {
  const normalized = mod.normalizeCouncilItem({
    id: 'legacy-1',
    title: 'Telegram Webhook Integration',
    summary: 'Telegram-heavy operations would benefit from async processing, idempotency, and status feedback.',
    proactive_lens: 'infrastructure',
    council_confidence: 'medium',
    created_at: '2026-01-01T00:00:00.000Z',
    debate_summary: ['Legacy evidence line'],
    key_disagreements: [{ model: 'legacy-review', concern: 'Legacy concern', resolution: 'Legacy resolution' }],
    council_recommendation: 'Legacy recommendation',
    passing_reasoning: 'Legacy reasoning',
  }, { now: '2026-04-30T12:00:00.000Z' });

  assert.deepEqual(
    normalized.deliberation.roles.map((role) => role.role),
    ['proposer', 'skeptic', 'cost_risk_reviewer', 'implementation_planner', 'final_recommendation']
  );
  assert.ok(normalized.deliberation.roles.every((role) => role.summary));
  assert.deepEqual(normalized.key_disagreements, normalized.deliberation.key_disagreements);
  assert.equal(normalized.council_recommendation, normalized.deliberation.recommendation);
  assert.equal(normalized.passing_reasoning, normalized.deliberation.passing_reasoning);
  assert.equal(normalized.council_confidence, normalized.deliberation.confidence);
  assert.ok(normalized.evidence_telemetry);
  assert.deepEqual(normalized.source_ids, ['legacy-1']);
  assert.equal(normalized.recurrence_count, 1);
  assert.ok(normalized.evidence_telemetry.staleness_days >= 100);
  assert.equal(normalized.council_confidence, 'low');
});

test('mergeCouncilItems dedupes repeated ingestion and upgrades legacy records with richer incoming data', () => {
  const existing = [{ id: 'old-1', title: 'Docker Deployment Pipeline', created_at: 'old' }];
  const incoming = [
    {
      id: 'new-1',
      title: 'Docker Deployment Pipeline',
      created_at: 'new',
      debate_summary: ['Evidence: real signal'],
      council_recommendation: 'Build a narrow CI workflow.',
      proactive_lens: 'efficiency',
      evidence_telemetry: {
        evidence_snippets: ['docker build deployment pipeline repeated', 'build deploy cache approval gate'],
        source_ids: ['merge-1', 'merge-2', 'merge-3', 'merge-4'],
        recurrence_count: 4,
        most_recent_at: '2026-04-30T10:00:00.000Z',
        oldest_at: '2026-04-27T10:00:00.000Z',
        staleness_days: 0,
        stale_signal_decay: 1,
        confidence_score: 0.973,
        confidence_label: 'high',
      },
      council_confidence: 'high',
    },
    { id: 'new-2', title: 'Telegram Webhook Integration', created_at: 'new' },
  ];

  const merged = mod.mergeCouncilItems(existing, incoming);
  const docker = merged.find((x) => x.title === 'Docker Deployment Pipeline');
  assert.equal(merged.length, 2);
  assert.equal(docker.id, 'old-1');
  assert.deepEqual(docker.debate_summary, ['Evidence: real signal']);
  assert.equal(docker.council_recommendation, 'Build a narrow CI workflow.');
  assert.equal(docker.proactive_lens, 'efficiency');
  assert.equal(docker.council_confidence, 'high');
  assert.deepEqual(
    docker.deliberation.roles.map((role) => role.role),
    ['proposer', 'skeptic', 'cost_risk_reviewer', 'implementation_planner', 'final_recommendation']
  );
});

test('project list includes active open projects and excludes archived projects', () => {
  const activeProjects = {
    'dashboard-v1': {
      name: 'openclaw-dashboard-v1',
      status: 'active',
      description: 'Dashboard work',
      created_at: '2026-04-01T00:00:00Z',
      tasks: [{ status: 'completed' }, { status: 'pending' }],
    },
    archived: {
      name: 'openclaw-dashboard-old',
      status: 'archived',
      description: 'Old work',
      created_at: '2026-03-01T00:00:00Z',
    },
    unnamed: {
      status: 'active',
      description: 'No explicit name but should still be displayable',
      created_at: '2026-04-02T00:00:00Z',
    },
  };

  const projects = mod.transformActiveProjects(activeProjects);
  assert.deepEqual(projects.map((p) => p.id).sort(), ['dashboard-v1', 'unnamed']);
  assert.equal(projects.find((p) => p.id === 'dashboard-v1').status, 'Pending');
});

test('discoverActiveProjectsSource prefers an existing env override over all other sources', () => {
  const tempRoot = makeTempDir('active-projects-env-');
  const repoRoot = path.join(tempRoot, 'repo');
  const homeDir = path.join(tempRoot, 'home');
  const envPath = path.join(tempRoot, 'override', 'active_projects.json');
  const defaultPath = path.join(homeDir, '.openclaw', 'workspace', 'memory', 'active_projects.json');
  const repoPath = path.join(repoRoot, 'active_projects.json');

  writeJson(envPath, { env: { status: 'active' } });
  writeJson(defaultPath, { default: { status: 'active' } });
  writeJson(repoPath, { repo: { status: 'active' } });

  const source = mod.discoverActiveProjectsSource({
    env: { OPENCLAW_ACTIVE_PROJECTS_PATH: envPath },
    homeDir,
    repoRoot,
  });

  assert.equal(source.status, 'found');
  assert.equal(source.source.path, envPath);
  assert.equal(source.source.type, 'env');
});

test('discoverActiveProjectsSource uses canonical fallback order after env override', () => {
  const tempRoot = makeTempDir('active-projects-fallback-');
  const repoRoot = path.join(tempRoot, 'repo');
  const homeDir = path.join(tempRoot, 'home');
  const defaultPath = path.join(homeDir, '.openclaw', 'workspace', 'memory', 'active_projects.json');
  const repoPath = path.join(repoRoot, 'active_projects.json');
  const repoMemoryPath = path.join(repoRoot, 'memory', 'active_projects.json');

  writeJson(defaultPath, { default: { status: 'active' } });
  writeJson(repoPath, { repo: { status: 'active' } });
  writeJson(repoMemoryPath, { repoMemory: { status: 'active' } });

  const fromDefault = mod.discoverActiveProjectsSource({ env: {}, homeDir, repoRoot });
  assert.equal(fromDefault.source.path, defaultPath);
  assert.equal(fromDefault.source.type, 'workspace-memory');

  fs.rmSync(defaultPath);
  const fromRepoRoot = mod.discoverActiveProjectsSource({ env: {}, homeDir, repoRoot });
  assert.equal(fromRepoRoot.source.path, repoPath);
  assert.equal(fromRepoRoot.source.type, 'repo-root');

  fs.rmSync(repoPath);
  const fromRepoMemory = mod.discoverActiveProjectsSource({ env: {}, homeDir, repoRoot });
  assert.equal(fromRepoMemory.source.path, repoMemoryPath);
  assert.equal(fromRepoMemory.source.type, 'repo-memory');
});

test('readActiveProjectsInventory returns an honest empty result with source metadata when no active projects remain', () => {
  const tempRoot = makeTempDir('active-projects-empty-');
  const repoRoot = path.join(tempRoot, 'repo');
  const homeDir = path.join(tempRoot, 'home');
  const repoMemoryPath = path.join(repoRoot, 'memory', 'active_projects.json');

  writeJson(repoMemoryPath, {
    archived: { status: 'archived', name: 'Old Project' },
    completed: { status: 'completed', name: 'Finished Project' },
  });

  const inventory = mod.readActiveProjectsInventory({ env: {}, homeDir, repoRoot });

  assert.deepEqual(inventory.projects, []);
  assert.equal(inventory.total, 0);
  assert.equal(inventory.status, 'empty');
  assert.equal(inventory.source.path, repoMemoryPath);
  assert.equal(inventory.source.type, 'repo-memory');
  assert.match(inventory.reason, /no active projects/i);
});


test('validateCommandRequest requires confirmation for side-effecting commands', () => {
  const missing = mod.validateCommandRequest('ingest-usage', {});
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 409);
  assert.equal(missing.confirmationRequired, true);

  const confirmed = mod.validateCommandRequest('ingest-usage', { confirm: true });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.command.id, 'ingest-usage');

  const dryRun = mod.validateCommandRequest('dry-run', {});
  assert.equal(dryRun.ok, true);
});

test('validateLocalOperatorRequest requires an operator token unless unauthenticated local mode is explicit', () => {
  const previousToken = process.env.OPENCLAW_OPERATOR_TOKEN;
  const previousAllow = process.env.OPENCLAW_ALLOW_UNAUTHENTICATED_LOCAL_OPERATOR_UI;
  try {
    delete process.env.OPENCLAW_OPERATOR_TOKEN;
    delete process.env.OPENCLAW_ALLOW_UNAUTHENTICATED_LOCAL_OPERATOR_UI;

    const localRequest = new Request('http://localhost/api/rd-council-items', {
      headers: { host: 'localhost' },
    });
    const denied = mod.validateLocalOperatorRequest(localRequest);
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 401);
    assert.match(denied.reason, /OPENCLAW_OPERATOR_TOKEN/);

    process.env.OPENCLAW_OPERATOR_TOKEN = 'test-operator-token';
    const spoofedHost = new Request('http://localhost/api/approve-v25', {
      headers: { host: 'localhost' },
    });
    assert.equal(mod.validateLocalOperatorRequest(spoofedHost).ok, false);

    const authorized = new Request('http://public.example/api/approve-v25', {
      headers: { 'x-openclaw-operator-token': 'test-operator-token' },
    });
    assert.equal(mod.validateLocalOperatorRequest(authorized).ok, true);

    delete process.env.OPENCLAW_OPERATOR_TOKEN;
    process.env.OPENCLAW_ALLOW_UNAUTHENTICATED_LOCAL_OPERATOR_UI = 'true';
    assert.equal(mod.validateLocalOperatorRequest(localRequest).ok, true);
  } finally {
    if (previousToken === undefined) delete process.env.OPENCLAW_OPERATOR_TOKEN;
    else process.env.OPENCLAW_OPERATOR_TOKEN = previousToken;
    if (previousAllow === undefined) delete process.env.OPENCLAW_ALLOW_UNAUTHENTICATED_LOCAL_OPERATOR_UI;
    else process.env.OPENCLAW_ALLOW_UNAUTHENTICATED_LOCAL_OPERATOR_UI = previousAllow;
  }
});

test('commandOk returns UI-friendly log lines and details', () => {
  const payload = mod.commandOk({
    command: { id: 'dry-run', label: 'Dry Run' },
    message: 'Dry run complete',
    output: ['line one', 'line two'],
    details: { mode: 'dry-run' },
  });

  assert.equal(payload.success, true);
  assert.equal(payload.command_id, 'dry-run');
  assert.deepEqual(payload.log_lines, ['line one', 'line two']);
  assert.equal(payload.output, 'line one\nline two');
  assert.equal(payload.details.mode, 'dry-run');
});

test('applyCouncilDecision persists approval, appends audit, and moves matching idea ledger entry to adopted', () => {
  const tempRoot = makeTempDir('rd-council-approve-');
  const councilPath = path.join(tempRoot, 'rd-council-items.json');
  const ledgerPath = path.join(tempRoot, 'idea_ledger.json');
  const auditPath = path.join(tempRoot, 'rd-council-audit.jsonl');

  writeJson(councilPath, [
    {
      id: 'rdc-approve-1',
      title: 'Decision Test',
      summary: 'Persist approve decision',
      created_at: '2026-04-30T12:00:00.000Z',
      stage: 'council',
      council_session_id: 'session-1',
      promotion_reason: 'test',
      proposing_model: 'test-model',
      origin_type: 'proactive',
      origin_tags: ['test'],
      proactive_lens: 'efficiency',
      idea_ledger_id: 'ledger-rdc-approve-1',
      council_confidence: 'high',
      debate_summary: ['Evidence: test'],
      key_disagreements: [],
      council_recommendation: 'Approve it',
      passing_reasoning: 'test',
      escalation_type: 'auto',
      session_type: 'scheduled',
      scheduled_for: '2026-04-30T12:00:00.000Z',
      session_time_of_day: 'evening',
      decision: null,
      is_hidden: false,
    },
  ]);
  writeJson(ledgerPath, {
    proposed: [{ id: 'idea-1', idea_ledger_id: 'ledger-rdc-approve-1', title: 'Decision Test' }],
    adopted: [],
    rejected: [],
    dormant: [],
  });

  const result = mod.applyCouncilDecision({
    itemId: 'rdc-approve-1',
    decision: 'approved',
    note: 'Ship the narrow version first.',
    actor: 'test-runner',
    now: '2026-05-01T00:00:00.000Z',
    councilPath,
    ledgerPath,
    auditPath,
  });

  assert.equal(result.item.decision, 'approved');
  assert.equal(result.item.decision_note, 'Ship the narrow version first.');
  assert.equal(result.item.decision_at, '2026-05-01T00:00:00.000Z');
  assert.equal(result.item.is_hidden, false);
  assert.equal(result.item.hidden_until, null);
  assert.equal(result.item.snooze_until, null);
  assert.equal(result.item.decision_history.length, 1);
  assert.equal(result.item.decision_history[0].decision, 'approved');
  assert.equal(result.item.decision_history[0].note, 'Ship the narrow version first.');
  assert.equal(result.item.decision_history[0].actor, 'test-runner');

  const persistedItems = mod.readJsonFile(councilPath, []);
  assert.equal(persistedItems[0].decision_history.length, 1);

  const persistedLedger = mod.readJsonFile(ledgerPath, {});
  assert.equal(persistedLedger.proposed.length, 0);
  assert.equal(persistedLedger.adopted.length, 1);
  assert.equal(persistedLedger.adopted[0].idea_ledger_id, 'ledger-rdc-approve-1');
  assert.equal(persistedLedger.adopted[0].decision, 'approved');
  assert.equal(persistedLedger.adopted[0].decision_note, 'Ship the narrow version first.');
  assert.equal(persistedLedger.adopted[0].decision_at, '2026-05-01T00:00:00.000Z');

  const auditLines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(auditLines.length, 1);
  assert.equal(auditLines[0].decision, 'approved');
  assert.equal(auditLines[0].item_id, 'rdc-approve-1');
  assert.equal(auditLines[0].idea_ledger_id, 'ledger-rdc-approve-1');
  assert.equal(auditLines[0].actor, 'test-runner');
});

test('applyCouncilDecision persists rejection history and keeps only one ledger record when repeated', () => {
  const tempRoot = makeTempDir('rd-council-reject-');
  const councilPath = path.join(tempRoot, 'rd-council-items.json');
  const ledgerPath = path.join(tempRoot, 'idea_ledger.json');
  const auditPath = path.join(tempRoot, 'rd-council-audit.jsonl');

  writeJson(councilPath, [
    {
      id: 'rdc-reject-1',
      title: 'Reject Test',
      summary: 'Persist reject decision',
      created_at: '2026-04-30T12:00:00.000Z',
      stage: 'council',
      council_session_id: 'session-1',
      promotion_reason: 'test',
      proposing_model: 'test-model',
      origin_type: 'proactive',
      origin_tags: ['test'],
      proactive_lens: 'pattern',
      idea_ledger_id: 'ledger-rdc-reject-1',
      council_confidence: 'medium',
      debate_summary: ['Evidence: test'],
      key_disagreements: [],
      council_recommendation: 'Reject it',
      passing_reasoning: 'test',
      escalation_type: 'auto',
      session_type: 'scheduled',
      scheduled_for: '2026-04-30T12:00:00.000Z',
      session_time_of_day: 'evening',
      decision: null,
      is_hidden: false,
    },
  ]);
  writeJson(ledgerPath, {
    proposed: [{ id: 'idea-2', idea_ledger_id: 'ledger-rdc-reject-1', title: 'Reject Test' }],
    adopted: [],
    rejected: [],
    dormant: [],
  });

  mod.applyCouncilDecision({
    itemId: 'rdc-reject-1',
    decision: 'rejected',
    note: 'Too broad right now.',
    actor: 'reviewer-a',
    now: '2026-05-01T01:00:00.000Z',
    councilPath,
    ledgerPath,
    auditPath,
  });

  const result = mod.applyCouncilDecision({
    itemId: 'rdc-reject-1',
    decision: 'rejected',
    note: 'Still blocked on scope.',
    actor: 'reviewer-b',
    now: '2026-05-01T02:00:00.000Z',
    councilPath,
    ledgerPath,
    auditPath,
  });

  assert.equal(result.item.decision, 'rejected');
  assert.equal(result.item.decision_note, 'Still blocked on scope.');
  assert.equal(result.item.decision_history.length, 2);
  assert.deepEqual(
    result.item.decision_history.map((entry) => [entry.decision, entry.note, entry.actor, entry.at]),
    [
      ['rejected', 'Too broad right now.', 'reviewer-a', '2026-05-01T01:00:00.000Z'],
      ['rejected', 'Still blocked on scope.', 'reviewer-b', '2026-05-01T02:00:00.000Z'],
    ]
  );

  const persistedLedger = mod.readJsonFile(ledgerPath, {});
  assert.equal(persistedLedger.proposed.length, 0);
  assert.equal(persistedLedger.rejected.length, 1);
  assert.equal(persistedLedger.rejected[0].idea_ledger_id, 'ledger-rdc-reject-1');
  assert.equal(persistedLedger.rejected[0].decision_note, 'Still blocked on scope.');
  assert.equal(persistedLedger.rejected[0].decision_at, '2026-05-01T02:00:00.000Z');

  const auditLines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(auditLines.length, 2);
  assert.deepEqual(auditLines.map((line) => line.decision), ['rejected', 'rejected']);
});

test('applyCouncilDecision persists snooze metadata, appends history, and moves matching idea ledger entry to dormant', () => {
  const tempRoot = makeTempDir('rd-council-snooze-');
  const councilPath = path.join(tempRoot, 'rd-council-items.json');
  const ledgerPath = path.join(tempRoot, 'idea_ledger.json');
  const auditPath = path.join(tempRoot, 'rd-council-audit.jsonl');

  writeJson(councilPath, [
    {
      id: 'rdc-snooze-1',
      title: 'Snooze Test',
      summary: 'Persist snooze decision',
      created_at: '2026-04-30T12:00:00.000Z',
      stage: 'council',
      council_session_id: 'session-1',
      promotion_reason: 'test',
      proposing_model: 'test-model',
      origin_type: 'proactive',
      origin_tags: ['test'],
      proactive_lens: 'infrastructure',
      idea_ledger_id: 'ledger-rdc-snooze-1',
      council_confidence: 'low',
      debate_summary: ['Evidence: test'],
      key_disagreements: [],
      council_recommendation: 'Snooze it',
      passing_reasoning: 'test',
      escalation_type: 'auto',
      session_type: 'scheduled',
      scheduled_for: '2026-04-30T12:00:00.000Z',
      session_time_of_day: 'evening',
      decision: null,
      is_hidden: false,
    },
  ]);
  writeJson(ledgerPath, {
    proposed: [{ id: 'idea-3', idea_ledger_id: 'ledger-rdc-snooze-1', title: 'Snooze Test' }],
    adopted: [],
    rejected: [],
    dormant: [],
  });

  const result = mod.applyCouncilDecision({
    itemId: 'rdc-snooze-1',
    decision: 'snoozed',
    note: 'Revisit after the dashboard refresh lands.',
    snoozeUntil: '2026-06-01T00:00:00.000Z',
    actor: 'scheduler',
    now: '2026-05-01T03:00:00.000Z',
    councilPath,
    ledgerPath,
    auditPath,
  });

  assert.equal(result.item.decision, 'snoozed');
  assert.equal(result.item.snooze_until, '2026-06-01T00:00:00.000Z');
  assert.equal(result.item.hidden_until, '2026-06-01T00:00:00.000Z');
  assert.equal(result.item.is_hidden, true);
  assert.equal(result.item.decision_history.length, 1);
  assert.equal(result.item.decision_history[0].decision, 'snoozed');
  assert.equal(result.item.decision_history[0].snooze_until, '2026-06-01T00:00:00.000Z');

  const persistedLedger = mod.readJsonFile(ledgerPath, {});
  assert.equal(persistedLedger.proposed.length, 0);
  assert.equal(persistedLedger.dormant.length, 1);
  assert.equal(persistedLedger.dormant[0].idea_ledger_id, 'ledger-rdc-snooze-1');
  assert.equal(persistedLedger.dormant[0].decision, 'snoozed');
  assert.equal(persistedLedger.dormant[0].snooze_until, '2026-06-01T00:00:00.000Z');

  const auditLines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(auditLines.length, 1);
  assert.equal(auditLines[0].decision, 'snoozed');
  assert.equal(auditLines[0].snooze_until, '2026-06-01T00:00:00.000Z');
});

test('buildCouncilWorkOrder returns a complete deterministic handoff object from an approved council item', () => {
  const councilItem = mod.normalizeCouncilItem(
    {
      id: 'rdc-work-order-1',
      title: 'Deterministic Deployment Pipeline',
      summary: 'Create a local-only deployment handoff with explicit checkpoints and acceptance criteria.',
      created_at: '2026-04-29T12:00:00.000Z',
      proactive_lens: 'efficiency',
      idea_ledger_id: 'ledger-rdc-work-order-1',
      evidence_telemetry: {
        evidence_snippets: [
          'deployment approvals are repeated in operator review',
          'pipeline caching and rollback steps recur across sessions',
        ],
        source_ids: ['session-11', 'session-18'],
        recurrence_count: 4,
        most_recent_at: '2026-04-29T11:00:00.000Z',
        oldest_at: '2026-04-20T11:00:00.000Z',
        staleness_days: 1,
        stale_signal_decay: 0.967,
        confidence_score: 0.87,
        confidence_label: 'high',
      },
      source_ids: ['session-11', 'session-18'],
      recurrence_count: 4,
      council_confidence: 'high',
      debate_summary: [
        'Evidence: repeated approval and deployment friction across operators.',
        'Implementation Plan: create one durable handoff record with explicit steps.',
      ],
      key_disagreements: [
        {
          model: 'skeptic',
          concern: 'A generic handoff could become vague and non-actionable.',
          resolution: 'Keep one record with explicit scope, evidence, and acceptance criteria.',
        },
      ],
      council_recommendation: 'Approve a narrow work-order handoff with deterministic local persistence.',
      passing_reasoning: 'High confidence based on repeated evidence and operator-visible need.',
      deliberation: {
        roles: [
          {
            role: 'proposer',
            summary: 'The repeated signal justifies a local handoff artifact.',
            points: ['Codify the approved scope for operator follow-through.'],
          },
          {
            role: 'skeptic',
            summary: 'The handoff must stay concrete.',
            points: ['Avoid generic backlog prose.'],
          },
          {
            role: 'cost_risk_reviewer',
            summary: 'The cost is acceptable if the record is idempotent.',
            points: ['Repeated approvals must not duplicate work orders.'],
          },
          {
            role: 'implementation_planner',
            summary: 'Persist one operator-ready work order with steps and criteria.',
            points: [
              'Implementation step: write the handoff record locally.',
              'Implementation step: link it from the council item and idea ledger.',
              'Acceptance criteria: repeated approvals preserve one work order.',
              'Acceptance criteria: evidence and recommendation remain attached.',
            ],
          },
          {
            role: 'final_recommendation',
            summary: 'Approve the handoff.',
            points: ['Promote the item into a durable work order.'],
          },
        ],
      },
      decision: 'approved',
      decision_at: '2026-05-01T00:00:00.000Z',
    },
    { now: '2026-05-01T00:00:00.000Z' }
  );

  const workOrder = mod.buildCouncilWorkOrder(councilItem, { now: '2026-05-01T00:00:00.000Z' });

  assert.equal(workOrder.id, 'work-order-rdc-work-order-1');
  assert.equal(workOrder.idempotency_key, 'rdc-work-order-1:deterministic-deployment-pipeline');
  assert.equal(workOrder.council_item_id, 'rdc-work-order-1');
  assert.equal(workOrder.idea_ledger_id, 'ledger-rdc-work-order-1');
  assert.equal(workOrder.title, 'Deterministic Deployment Pipeline');
  assert.equal(workOrder.summary, 'Create a local-only deployment handoff with explicit checkpoints and acceptance criteria.');
  assert.match(workOrder.description, /local-only deployment handoff/i);
  assert.equal(workOrder.status, 'approved');
  assert.equal(workOrder.priority, 'high');
  assert.equal(workOrder.confidence, 'high');
  assert.equal(workOrder.created_at, '2026-05-01T00:00:00.000Z');
  assert.equal(workOrder.updated_at, '2026-05-01T00:00:00.000Z');
  assert.deepEqual(workOrder.source_ids, ['session-11', 'session-18']);
  assert.deepEqual(workOrder.evidence_snippets, [
    'deployment approvals are repeated in operator review',
    'pipeline caching and rollback steps recur across sessions',
  ]);
  assert.equal(workOrder.recommendation, 'Approve a narrow work-order handoff with deterministic local persistence.');
  assert.deepEqual(workOrder.implementation_steps, [
    'write the handoff record locally.',
    'link it from the council item and idea ledger.',
  ]);
  assert.deepEqual(workOrder.acceptance_criteria, [
    'repeated approvals preserve one work order.',
    'evidence and recommendation remain attached.',
  ]);
  assert.equal(workOrder.links.council_item_id, 'rdc-work-order-1');
  assert.equal(workOrder.links.idea_ledger_id, 'ledger-rdc-work-order-1');
  assert.equal(workOrder.references.council_item_title, 'Deterministic Deployment Pipeline');
  assert.deepEqual(workOrder.deliberation.key_disagreements, councilItem.key_disagreements);
});

test('applyCouncilDecision on approval persists one work order record and remains idempotent on repeated approvals', () => {
  const tempRoot = makeTempDir('rd-council-work-order-');
  const councilPath = path.join(tempRoot, 'rd-council-items.json');
  const ledgerPath = path.join(tempRoot, 'idea_ledger.json');
  const auditPath = path.join(tempRoot, 'rd-council-audit.jsonl');
  const workOrdersPath = path.join(tempRoot, 'rd-council-work-orders.json');

  writeJson(councilPath, [
    {
      id: 'rdc-approve-work-order-1',
      title: 'Approval Work Order Test',
      summary: 'Persist one operator-ready handoff record.',
      created_at: '2026-04-30T12:00:00.000Z',
      stage: 'council',
      council_session_id: 'session-1',
      promotion_reason: 'test',
      proposing_model: 'test-model',
      origin_type: 'proactive',
      origin_tags: ['test'],
      proactive_lens: 'efficiency',
      idea_ledger_id: 'ledger-rdc-approve-work-order-1',
      evidence_telemetry: {
        evidence_snippets: ['evidence snippet 1', 'evidence snippet 2'],
        source_ids: ['source-1', 'source-2'],
        recurrence_count: 3,
        most_recent_at: '2026-04-30T12:00:00.000Z',
        oldest_at: '2026-04-28T12:00:00.000Z',
        staleness_days: 0,
        stale_signal_decay: 1,
        confidence_score: 0.81,
        confidence_label: 'high',
      },
      council_confidence: 'high',
      debate_summary: ['Evidence: test'],
      key_disagreements: [],
      council_recommendation: 'Approve and hand off.',
      passing_reasoning: 'test',
      deliberation: {
        roles: [
          { role: 'proposer', summary: 'Approve it.', points: ['Evidence is strong.'] },
          { role: 'skeptic', summary: 'Keep scope tight.', points: ['Avoid duplicates.'] },
          { role: 'cost_risk_reviewer', summary: 'Idempotency matters.', points: ['One record only.'] },
          {
            role: 'implementation_planner',
            summary: 'Write the handoff.',
            points: [
              'Implementation step: create a durable work order record.',
              'Acceptance criteria: repeated approvals do not duplicate the handoff.',
            ],
          },
          { role: 'final_recommendation', summary: 'Approve and persist.', points: ['Proceed.'] },
        ],
      },
      escalation_type: 'auto',
      session_type: 'scheduled',
      scheduled_for: '2026-04-30T12:00:00.000Z',
      session_time_of_day: 'evening',
      decision: null,
      is_hidden: false,
    },
  ]);
  writeJson(ledgerPath, {
    proposed: [{ id: 'idea-4', idea_ledger_id: 'ledger-rdc-approve-work-order-1', title: 'Approval Work Order Test' }],
    adopted: [],
    rejected: [],
    dormant: [],
  });

  const first = mod.applyCouncilDecision({
    itemId: 'rdc-approve-work-order-1',
    decision: 'approved',
    note: 'Create the operator handoff.',
    actor: 'reviewer-a',
    now: '2026-05-01T00:00:00.000Z',
    councilPath,
    ledgerPath,
    auditPath,
    workOrdersPath,
  });

  const second = mod.applyCouncilDecision({
    itemId: 'rdc-approve-work-order-1',
    decision: 'approved',
    note: 'Create the operator handoff.',
    actor: 'reviewer-a',
    now: '2026-05-01T01:00:00.000Z',
    councilPath,
    ledgerPath,
    auditPath,
    workOrdersPath,
  });

  assert.equal(first.item.work_order_id, 'work-order-rdc-approve-work-order-1');
  assert.equal(first.item.work_order_handoff_id, 'work-order-rdc-approve-work-order-1');
  assert.equal(second.item.work_order_id, 'work-order-rdc-approve-work-order-1');
  assert.equal(second.item.work_order_handoff_id, 'work-order-rdc-approve-work-order-1');
  assert.equal(first.workOrder.id, 'work-order-rdc-approve-work-order-1');
  assert.equal(second.workOrder.id, 'work-order-rdc-approve-work-order-1');

  const persistedWorkOrders = mod.readJsonFile(workOrdersPath, []);
  assert.equal(persistedWorkOrders.length, 1);
  assert.equal(persistedWorkOrders[0].id, 'work-order-rdc-approve-work-order-1');
  assert.equal(persistedWorkOrders[0].council_item_id, 'rdc-approve-work-order-1');
  assert.equal(persistedWorkOrders[0].idea_ledger_id, 'ledger-rdc-approve-work-order-1');
  assert.equal(persistedWorkOrders[0].updated_at, '2026-05-01T01:00:00.000Z');

  const persistedItems = mod.readJsonFile(councilPath, []);
  assert.equal(persistedItems[0].work_order_id, 'work-order-rdc-approve-work-order-1');
  assert.equal(persistedItems[0].work_order_handoff_id, 'work-order-rdc-approve-work-order-1');

  const persistedLedger = mod.readJsonFile(ledgerPath, {});
  assert.equal(persistedLedger.adopted.length, 1);
  assert.equal(persistedLedger.adopted[0].work_order_id, 'work-order-rdc-approve-work-order-1');
  assert.equal(persistedLedger.adopted[0].work_order_handoff_id, 'work-order-rdc-approve-work-order-1');
});

test('applyCouncilDecision does not create work order records for rejected or snoozed decisions', () => {
  const tempRoot = makeTempDir('rd-council-no-work-order-');
  const councilPath = path.join(tempRoot, 'rd-council-items.json');
  const ledgerPath = path.join(tempRoot, 'idea_ledger.json');
  const auditPath = path.join(tempRoot, 'rd-council-audit.jsonl');
  const workOrdersPath = path.join(tempRoot, 'rd-council-work-orders.json');

  writeJson(councilPath, [
    {
      id: 'rdc-reject-no-work-order',
      title: 'Reject No Work Order',
      summary: 'Rejected items should not create handoffs.',
      created_at: '2026-04-30T12:00:00.000Z',
      proactive_lens: 'pattern',
      idea_ledger_id: 'ledger-rdc-reject-no-work-order',
      council_confidence: 'medium',
      debate_summary: ['Evidence: reject test'],
      key_disagreements: [],
      council_recommendation: 'Reject it',
      passing_reasoning: 'test',
      decision: null,
      is_hidden: false,
    },
    {
      id: 'rdc-snooze-no-work-order',
      title: 'Snooze No Work Order',
      summary: 'Snoozed items should not create handoffs.',
      created_at: '2026-04-30T12:00:00.000Z',
      proactive_lens: 'infrastructure',
      idea_ledger_id: 'ledger-rdc-snooze-no-work-order',
      council_confidence: 'low',
      debate_summary: ['Evidence: snooze test'],
      key_disagreements: [],
      council_recommendation: 'Snooze it',
      passing_reasoning: 'test',
      decision: null,
      is_hidden: false,
    },
  ]);
  writeJson(ledgerPath, {
    proposed: [
      { id: 'idea-5', idea_ledger_id: 'ledger-rdc-reject-no-work-order', title: 'Reject No Work Order' },
      { id: 'idea-6', idea_ledger_id: 'ledger-rdc-snooze-no-work-order', title: 'Snooze No Work Order' },
    ],
    adopted: [],
    rejected: [],
    dormant: [],
  });

  const rejected = mod.applyCouncilDecision({
    itemId: 'rdc-reject-no-work-order',
    decision: 'rejected',
    note: 'Not worth implementing.',
    actor: 'reviewer-a',
    now: '2026-05-01T00:00:00.000Z',
    councilPath,
    ledgerPath,
    auditPath,
    workOrdersPath,
  });

  const snoozed = mod.applyCouncilDecision({
    itemId: 'rdc-snooze-no-work-order',
    decision: 'snoozed',
    note: 'Wait for the next cycle.',
    snoozeUntil: '2026-06-01T00:00:00.000Z',
    actor: 'reviewer-b',
    now: '2026-05-01T01:00:00.000Z',
    councilPath,
    ledgerPath,
    auditPath,
    workOrdersPath,
  });

  assert.equal(rejected.workOrder, null);
  assert.equal(snoozed.workOrder, null);

  const persistedWorkOrders = mod.readJsonFile(workOrdersPath, []);
  assert.deepEqual(persistedWorkOrders, []);

  const persistedItems = mod.readJsonFile(councilPath, []);
  assert.equal(persistedItems[0].work_order_id ?? null, null);
  assert.equal(persistedItems[1].work_order_id ?? null, null);
});

test('summarizeCouncilItemOperatorState reports operator-useful badges and summaries across item states', () => {
  const now = '2026-05-10T12:00:00.000Z';

  const approved = mod.summarizeCouncilItemOperatorState(
    {
      id: 'approved-1',
      title: 'Approved Item',
      summary: 'Approved summary',
      created_at: '2026-05-01T12:00:00.000Z',
      proactive_lens: 'efficiency',
      council_confidence: 'high',
      decision: 'approved',
      decision_at: '2026-05-09T09:00:00.000Z',
      decision_note: 'Ship it.',
      decision_history: [
        {
          decision: 'approved',
          at: '2026-05-09T09:00:00.000Z',
          actor: 'reviewer-a',
          note: 'Ship it.',
        },
      ],
      is_hidden: false,
      work_order_id: 'work-order-approved-1',
      evidence_telemetry: {
        evidence_snippets: ['signal'],
        source_ids: ['source-1', 'source-2'],
        recurrence_count: 3,
        most_recent_at: '2026-05-09T08:00:00.000Z',
        oldest_at: '2026-05-01T08:00:00.000Z',
        staleness_days: 1,
        stale_signal_decay: 0.967,
        confidence_score: 0.88,
        confidence_label: 'high',
      },
    },
    { now }
  );
  assert.equal(approved.summary, 'Approved and handed off');
  assert.ok(approved.badges.some((badge) => badge.label === 'Approved'));
  assert.ok(approved.badges.some((badge) => badge.label === 'Work order ready'));
  assert.equal(approved.workOrderLabel, 'work-order-approved-1');

  const rejected = mod.summarizeCouncilItemOperatorState(
    {
      id: 'rejected-1',
      title: 'Rejected Item',
      summary: 'Rejected summary',
      created_at: '2026-05-01T12:00:00.000Z',
      proactive_lens: 'pattern',
      council_confidence: 'medium',
      decision: 'rejected',
      decision_at: '2026-05-09T09:00:00.000Z',
      decision_history: [
        {
          decision: 'rejected',
          at: '2026-05-09T09:00:00.000Z',
          actor: 'reviewer-b',
          note: 'Too broad.',
        },
      ],
      is_hidden: false,
    },
    { now }
  );
  assert.equal(rejected.summary, 'Rejected');
  assert.ok(rejected.badges.some((badge) => badge.label === 'Rejected'));

  const snoozed = mod.summarizeCouncilItemOperatorState(
    {
      id: 'snoozed-1',
      title: 'Snoozed Item',
      summary: 'Snoozed summary',
      created_at: '2026-05-01T12:00:00.000Z',
      proactive_lens: 'infrastructure',
      council_confidence: 'low',
      decision: 'snoozed',
      decision_at: '2026-05-03T09:00:00.000Z',
      snooze_until: '2026-05-20T00:00:00.000Z',
      hidden_until: '2026-05-20T00:00:00.000Z',
      decision_history: [
        {
          decision: 'snoozed',
          at: '2026-05-03T09:00:00.000Z',
          actor: 'reviewer-c',
          note: 'Wait for more data.',
          snooze_until: '2026-05-20T00:00:00.000Z',
        },
      ],
      is_hidden: true,
    },
    { now }
  );
  assert.equal(snoozed.summary, 'Snoozed and hidden');
  assert.ok(snoozed.badges.some((badge) => badge.label === 'Snoozed'));
  assert.ok(snoozed.badges.some((badge) => badge.label === 'Hidden'));
  assert.equal(snoozed.hiddenLabel, 'Until 2026-05-20T00:00:00.000Z');

  const undecided = mod.summarizeCouncilItemOperatorState(
    {
      id: 'undecided-1',
      title: 'Undecided Item',
      summary: 'Undecided summary',
      created_at: '2026-05-01T12:00:00.000Z',
      proactive_lens: 'external',
      council_confidence: 'medium',
      decision: null,
      is_hidden: false,
    },
    { now }
  );
  assert.equal(undecided.summary, 'Awaiting operator decision');
  assert.ok(undecided.badges.some((badge) => badge.label === 'Undecided'));
});

test('getCouncilItemActionAvailability explains disabled duplicate actions from decision and hidden state', () => {
  const now = '2026-05-10T12:00:00.000Z';

  const approvedState = mod.getCouncilItemActionAvailability(
    {
      id: 'approved-1',
      title: 'Approved Item',
      summary: 'Approved summary',
      created_at: '2026-05-01T12:00:00.000Z',
      proactive_lens: 'efficiency',
      council_confidence: 'high',
      decision: 'approved',
      decision_at: '2026-05-09T09:00:00.000Z',
      is_hidden: false,
      work_order_id: 'work-order-approved-1',
    },
    { now }
  );
  assert.equal(approvedState.approve.disabled, true);
  assert.match(approvedState.approve.reason, /work order/i);
  assert.equal(approvedState.approve.label, 'Approved');
  assert.equal(approvedState.reject.disabled, false);
  assert.equal(approvedState.snooze.disabled, false);

  const rejectedState = mod.getCouncilItemActionAvailability(
    {
      id: 'rejected-1',
      title: 'Rejected Item',
      summary: 'Rejected summary',
      created_at: '2026-05-01T12:00:00.000Z',
      proactive_lens: 'pattern',
      council_confidence: 'medium',
      decision: 'rejected',
      decision_at: '2026-05-09T09:00:00.000Z',
      is_hidden: false,
    },
    { now }
  );
  assert.equal(rejectedState.reject.disabled, true);
  assert.match(rejectedState.reject.reason, /already rejected/i);
  assert.equal(rejectedState.reject.label, 'Rejected');

  const snoozedState = mod.getCouncilItemActionAvailability(
    {
      id: 'snoozed-1',
      title: 'Snoozed Item',
      summary: 'Snoozed summary',
      created_at: '2026-05-01T12:00:00.000Z',
      proactive_lens: 'infrastructure',
      council_confidence: 'low',
      decision: 'snoozed',
      decision_at: '2026-05-09T09:00:00.000Z',
      snooze_until: '2026-05-20T00:00:00.000Z',
      hidden_until: '2026-05-20T00:00:00.000Z',
      is_hidden: true,
    },
    { now }
  );
  assert.equal(snoozedState.snooze.disabled, true);
  assert.match(snoozedState.snooze.reason, /hidden until/i);
  assert.match(snoozedState.snooze.label, /snoozed/i);

  const undecidedState = mod.getCouncilItemActionAvailability(
    {
      id: 'undecided-1',
      title: 'Undecided Item',
      summary: 'Undecided summary',
      created_at: '2026-05-01T12:00:00.000Z',
      proactive_lens: 'external',
      council_confidence: 'medium',
      decision: null,
      is_hidden: false,
    },
    { now }
  );
  assert.deepEqual(
    {
      approve: undecidedState.approve.disabled,
      reject: undecidedState.reject.disabled,
      snooze: undecidedState.snooze.disabled,
    },
    {
      approve: false,
      reject: false,
      snooze: false,
    }
  );
});

test('formatCouncilDecisionApiError returns useful operator-facing failure text', () => {
  assert.equal(
    mod.formatCouncilDecisionApiError('approved', {
      response: { status: 409, statusText: 'Conflict' },
      payload: { message: 'Work order already exists for this item.' },
    }),
    'Approve failed (409): Work order already exists for this item.'
  );

  assert.equal(
    mod.formatCouncilDecisionApiError('rejected', {
      response: { status: 500, statusText: 'Internal Server Error' },
      payload: {},
    }),
    'Reject failed (500): Internal Server Error'
  );

  assert.equal(
    mod.formatCouncilDecisionApiError('snoozed', {
      response: { status: 400, statusText: 'Bad Request' },
      payload: { error: 'snoozeUntil must be a valid ISO timestamp.' },
    }),
    'Snooze failed (400): snoozeUntil must be a valid ISO timestamp.'
  );
});
