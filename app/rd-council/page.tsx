"use client";

import { useState, useEffect } from "react";
import { useI18n } from "@/lib/i18n";

type CouncilDecision = "approved" | "rejected" | "snoozed";
type CouncilConfidence = "high" | "medium" | "low";

interface EvidenceTelemetry {
  evidence_snippets?: string[];
  source_ids?: string[];
  recurrence_count?: number;
  most_recent_at?: string | null;
  oldest_at?: string | null;
  staleness_days?: number | null;
  stale_signal_decay?: number | null;
  confidence_score?: number | null;
  confidence_label?: CouncilConfidence;
}

interface DecisionHistoryEntry {
  decision: CouncilDecision;
  note?: string | null;
  actor?: string | null;
  at: string;
  snooze_until?: string | null;
}

interface CouncilItem {
  id: string;
  title: string;
  summary: string;
  created_at: string;
  stage: "trending" | "opportunity" | "council";
  proposing_model: string;
  origin_type: "reactive" | "proactive";
  origin_tags: string[];
  proactive_lens: "efficiency" | "infrastructure" | "pattern" | "external" | null;
  council_confidence: CouncilConfidence;
  debate_summary: string[];
  key_disagreements: { model: string; concern: string; resolution: string }[];
  council_recommendation: string;
  passing_reasoning: string;
  session_type: "scheduled" | "emergency";
  session_time_of_day: "morning" | "evening";
  decision: null | CouncilDecision;
  decision_note?: string | null;
  decision_at?: string | null;
  decision_history?: DecisionHistoryEntry[];
  snooze_until?: string | null;
  is_hidden: boolean;
  hidden_until?: string | null;
  work_order_id?: string | null;
  work_order_handoff_id?: string | null;
  evidence_telemetry?: EvidenceTelemetry;
  source_ids?: string[];
  recurrence_count?: number;
  confidence_score?: number;
  stale_signal_decay?: number;
}

const RDCOUNCIL_TABS = [
  { id: "trending", label: "nav.trending" },
  { id: "opportunity", label: "nav.opportunity" },
  { id: "council", label: "nav.rdCouncil" },
] as const;

function formatTimestamp(ts?: string | null): string {
  if (!ts) return "Unknown";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function isFutureTimestamp(ts?: string | null, now = new Date()): boolean {
  if (!ts) return false;
  const date = new Date(ts);
  return !Number.isNaN(date.getTime()) && date.getTime() > now.getTime();
}

function getDecisionLabel(decision: CouncilDecision | null): string {
  if (decision === "approved") return "Approved";
  if (decision === "rejected") return "Rejected";
  if (decision === "snoozed") return "Snoozed";
  return "Undecided";
}

function getActionLabel(decision: CouncilDecision): string {
  if (decision === "approved") return "Approve";
  if (decision === "rejected") return "Reject";
  return "Snooze";
}

function getActionErrorMessage(
  decision: CouncilDecision,
  input: {
    response?: { status?: number; statusText?: string };
    payload?: Record<string, unknown> | null;
    error?: unknown;
  }
): string {
  const status = typeof input.response?.status === "number" ? input.response.status : null;
  const payload = input.payload ?? {};
  const payloadMessage =
    typeof payload.message === "string" && payload.message.trim() !== ""
      ? payload.message
      : typeof payload.error === "string" && payload.error.trim() !== ""
        ? payload.error
        : null;
  const errorMessage =
    input.error instanceof Error && input.error.message.trim() !== "" ? input.error.message : null;
  const statusText =
    typeof input.response?.statusText === "string" && input.response.statusText.trim() !== ""
      ? input.response.statusText
      : null;
  const message = payloadMessage ?? errorMessage ?? statusText ?? "Request failed";

  return `${getActionLabel(decision)} failed${status ? ` (${status})` : ""}: ${message}`;
}

function getConfidenceTone(confidence: CouncilConfidence | undefined): string {
  if (confidence === "high") return "bg-green-100 text-green-800";
  if (confidence === "medium") return "bg-amber-100 text-amber-800";
  return "bg-slate-200 text-slate-700";
}

function summarizeOperatorState(item: CouncilItem, now = new Date()) {
  const latestDecision =
    item.decision_history?.[item.decision_history.length - 1] ??
    (item.decision
      ? {
          decision: item.decision,
          note: item.decision_note ?? null,
          actor: null,
          at: item.decision_at ?? item.created_at,
          snooze_until: item.snooze_until ?? null,
        }
      : null);
  const workOrderId = item.work_order_id ?? item.work_order_handoff_id ?? null;
  const hiddenUntil = item.hidden_until ?? item.snooze_until ?? null;
  const badges: Array<{ label: string; className: string }> = [];
  let summary = "Awaiting operator decision";

  if (item.decision === "approved") {
    summary = workOrderId ? "Approved and handed off" : "Approved";
    badges.push({ label: "Approved", className: "bg-emerald-100 text-emerald-800" });
    if (workOrderId) {
      badges.push({ label: "Work order ready", className: "bg-emerald-100 text-emerald-800" });
    }
  } else if (item.decision === "rejected") {
    summary = "Rejected";
    badges.push({ label: "Rejected", className: "bg-rose-100 text-rose-800" });
  } else if (item.decision === "snoozed" || item.is_hidden) {
    summary = item.is_hidden ? "Snoozed and hidden" : "Snoozed";
    if (item.decision === "snoozed") {
      badges.push({ label: "Snoozed", className: "bg-amber-100 text-amber-900" });
    }
    if (item.is_hidden) {
      badges.push({ label: "Hidden", className: "bg-slate-200 text-slate-700" });
    }
  } else {
    badges.push({ label: "Undecided", className: "bg-slate-200 text-slate-700" });
  }

  return {
    summary,
    badges,
    workOrderId,
    hiddenUntil,
    historyCount: item.decision_history?.length ?? 0,
    latestDecision,
    evidenceConfidence:
      item.evidence_telemetry?.confidence_label ?? item.council_confidence,
    evidenceConfidenceScore:
      item.evidence_telemetry?.confidence_score ?? item.confidence_score ?? null,
    recurrenceCount:
      item.evidence_telemetry?.recurrence_count ?? item.recurrence_count ?? 0,
    sourceCount:
      item.evidence_telemetry?.source_ids?.length ?? item.source_ids?.length ?? 0,
    stalenessDays: item.evidence_telemetry?.staleness_days ?? null,
    isCurrentlyHidden: item.is_hidden || isFutureTimestamp(hiddenUntil, now),
  };
}

function getActionAvailability(item: CouncilItem, now = new Date()) {
  const hiddenUntil = item.hidden_until ?? item.snooze_until ?? null;
  const hiddenUntilFuture = isFutureTimestamp(hiddenUntil, now);
  const workOrderId = item.work_order_id ?? item.work_order_handoff_id ?? null;

  return {
    approved:
      item.decision === "approved"
        ? {
            disabled: true,
            label: "Approved",
            reason: workOrderId
              ? `Already approved and handed off to work order ${workOrderId}.`
              : "Already approved.",
          }
        : {
            disabled: false,
            label: "Approve",
            reason: null,
          },
    rejected:
      item.decision === "rejected"
        ? {
            disabled: true,
            label: "Rejected",
            reason: "Already rejected.",
          }
        : {
            disabled: false,
            label: "Reject",
            reason: null,
          },
    snoozed:
      item.is_hidden || hiddenUntilFuture || item.decision === "snoozed"
        ? {
            disabled: true,
            label: hiddenUntil ? `Snoozed until ${formatTimestamp(hiddenUntil)}` : "Hidden",
            reason: hiddenUntil
              ? `Item is hidden until ${formatTimestamp(hiddenUntil)}.`
              : "Item is already hidden.",
          }
        : {
            disabled: false,
            label: "Snooze 7d",
            reason: null,
          },
  };
}

function Card({
  item,
  t,
  onDecision,
  isActionPending,
  actionError,
}: {
  item: CouncilItem;
  t: any;
  onDecision: (itemId: string, decision: CouncilDecision) => void;
  isActionPending: boolean;
  actionError?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const decisionHistory = item.decision_history ?? [];
  const operatorState = summarizeOperatorState(item);
  const actionAvailability = getActionAvailability(item);
  const disabledReasons = Object.values(actionAvailability)
    .map((action) => action.reason)
    .filter((reason): reason is string => Boolean(reason));

  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <span className="text-2xl font-bold text-[var(--text)] min-w-[160px]">{item.title}</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
            {t("rdc.estimated")} {item.proposing_model}
          </span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--border)] text-[var(--text-muted)]">
            {item.session_type === "scheduled" ? t("rdc.scheduled") : t("rdc.emergency")}
          </span>
          {item.origin_type === "proactive" && item.proactive_lens && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--accent)]/30 text-[var(--accent)]">
              {t(item.proactive_lens === "efficiency" ? "rdc.originTags.efficiency" :
                item.proactive_lens === "infrastructure" ? "rdc.originTags.infrastructure" :
                item.proactive_lens === "pattern" ? "rdc.originTags.pattern" : "rdc.originTags.external")}
            </span>
          )}
          <span className={`text-xs px-2 py-0.5 rounded-full ${getConfidenceTone(operatorState.evidenceConfidence)}`}>
            {(operatorState.evidenceConfidence ?? "medium").toUpperCase()} confidence
            {typeof operatorState.evidenceConfidenceScore === "number" ? ` ${operatorState.evidenceConfidenceScore.toFixed(3)}` : ""}
          </span>
          {operatorState.badges.map((badge) => (
            <span key={badge.label} className={`text-xs px-2 py-0.5 rounded-full ${badge.className}`}>
              {badge.label}
            </span>
          ))}
          {item.origin_tags.length > 0 && item.origin_tags.map((tag, i) => (
            <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-[var(--accent)]/20 text-[var(--accent)]">
              {tag}
            </span>
          ))}
        </div>
        <div className="text-xs text-[var(--text-muted)] whitespace-nowrap">
          {t("rdc.detected")} {formatTimestamp(item.created_at)}
        </div>
      </div>

      {/* Summary */}
      <div className="text-sm text-[var(--text-muted)] leading-relaxed">
        {item.summary}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="border border-[var(--border)] rounded-lg p-3 space-y-2">
          <div className="text-xs font-semibold text-[var(--text-muted)]">Operator State</div>
          <div className="text-sm font-medium text-[var(--text)]">{operatorState.summary}</div>
          <div className="text-xs text-[var(--text-muted)]">
            Decision: {getDecisionLabel(item.decision)}
            {item.decision_at ? ` on ${formatTimestamp(item.decision_at)}` : ""}
          </div>
          {operatorState.workOrderId && (
            <div className="text-xs text-[var(--text-muted)]">
              Work order: <span className="text-[var(--text)]">{operatorState.workOrderId}</span>
            </div>
          )}
          {operatorState.hiddenUntil && (
            <div className="text-xs text-[var(--text-muted)]">
              Hidden until: <span className="text-[var(--text)]">{formatTimestamp(operatorState.hiddenUntil)}</span>
            </div>
          )}
          {operatorState.historyCount > 0 && operatorState.latestDecision && (
            <div className="text-xs text-[var(--text-muted)]">
              History: {operatorState.historyCount} entr{operatorState.historyCount === 1 ? "y" : "ies"}
              {operatorState.latestDecision.actor ? `, latest by ${operatorState.latestDecision.actor}` : ""}
              {operatorState.latestDecision.at ? ` at ${formatTimestamp(operatorState.latestDecision.at)}` : ""}
            </div>
          )}
          {operatorState.latestDecision?.note && (
            <div className="text-xs text-[var(--text-muted)]">
              Latest note: {operatorState.latestDecision.note}
            </div>
          )}
        </div>

        <div className="border border-[var(--border)] rounded-lg p-3 space-y-2">
          <div className="text-xs font-semibold text-[var(--text-muted)]">Evidence Telemetry</div>
          <div className="grid grid-cols-2 gap-2 text-xs text-[var(--text-muted)]">
            <div>
              Confidence: <span className="text-[var(--text)]">{operatorState.evidenceConfidence ?? "unknown"}</span>
            </div>
            <div>
              Recurrence: <span className="text-[var(--text)]">{operatorState.recurrenceCount}</span>
            </div>
            <div>
              Source IDs: <span className="text-[var(--text)]">{operatorState.sourceCount}</span>
            </div>
            <div>
              Staleness: <span className="text-[var(--text)]">{operatorState.stalenessDays ?? "n/a"}d</span>
            </div>
          </div>
          {item.evidence_telemetry?.most_recent_at && (
            <div className="text-xs text-[var(--text-muted)]">
              Most recent signal: <span className="text-[var(--text)]">{formatTimestamp(item.evidence_telemetry.most_recent_at)}</span>
            </div>
          )}
          {item.evidence_telemetry?.evidence_snippets && item.evidence_telemetry.evidence_snippets.length > 0 && (
            <div className="space-y-1">
              {item.evidence_telemetry.evidence_snippets.slice(0, 3).map((snippet, index) => (
                <div key={`${item.id}-evidence-${index}`} className="text-xs text-[var(--text-muted)]">
                  Evidence {index + 1}: <span className="text-[var(--text)]">{snippet}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Expandable Debate Summary */}
      <div className="border-t border-[var(--border)] pt-3 mt-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs font-medium text-[var(--text)] hover:text-[var(--accent)] transition-colors flex items-center gap-1"
        >
          {expanded ? "▼" : "▲"} {t("rdc.debateSummary")}
        </button>
        {expanded && (
          <div className="mt-2 space-y-2">
            {item.debate_summary.map((bullet, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-[var(--text)]">
                <span className="text-[var(--accent)]">•</span>
                <span>{bullet}</span>
              </div>
            ))}
            {item.key_disagreements.length > 0 && (
              <div className="mt-2 pt-2 border-t border-[var(--border)]">
                <div className="text-xs font-semibold text-[var(--text-muted)] mb-1">
                  {t("rdc.disagreements")}
                </div>
                {item.key_disagreements.map((disagreement, i) => (
                  <div key={i} className="text-xs text-[var(--text)]">
                    <span className="text-[var(--accent)] font-medium">{disagreement.model}:</span>
                    <span className="mx-1 opacity-60">- {disagreement.concern}</span>
                    <span className="mx-1 opacity-60">→</span>
                    <span className="opacity-60">{disagreement.resolution}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Recommendation */}
      <div className="bg-[var(--bg)]/60 border border-[var(--accent)]/20 rounded-lg p-3">
        <div className="text-xs font-semibold text-[var(--accent)] mb-1">
          {t("rdc.recommendation")}
        </div>
        <div className="text-sm text-[var(--text)] leading-relaxed">
          {item.council_recommendation}
        </div>
        <div className="mt-2 text-xs text-[var(--text-muted)]">
          {t("rdc.passedReasoning")}: {item.passing_reasoning}
        </div>
      </div>

      {decisionHistory.length > 0 && (
        <div className="border border-[var(--border)] rounded-lg p-3 space-y-2">
          <div className="text-xs font-semibold text-[var(--text-muted)]">Decision History</div>
          {decisionHistory.slice().reverse().map((entry, index) => (
            <div key={`${entry.at}-${index}`} className="text-xs text-[var(--text)]">
              <span className="font-medium">
                {entry.decision === "approved" ? "Approved" : entry.decision === "rejected" ? "Rejected" : "Snoozed"}
              </span>
              <span className="mx-2 text-[var(--text-muted)]">{formatTimestamp(entry.at)}</span>
              {entry.actor && <span className="text-[var(--text-muted)]">by {entry.actor}</span>}
              {entry.note && <div className="mt-1 text-[var(--text-muted)]">{entry.note}</div>}
              {entry.snooze_until && (
                <div className="mt-1 text-[var(--text-muted)]">Until {formatTimestamp(entry.snooze_until)}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Action Buttons */}
      <div className="pt-2 border-t border-[var(--border)] space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <button
            onClick={() => onDecision(item.id, "approved")}
            disabled={isActionPending || actionAvailability.approved.disabled}
            title={actionAvailability.approved.reason ?? undefined}
            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {isActionPending ? "Saving..." : actionAvailability.approved.label}
          </button>
          <button
            onClick={() => onDecision(item.id, "rejected")}
            disabled={isActionPending || actionAvailability.rejected.disabled}
            title={actionAvailability.rejected.reason ?? undefined}
            className="px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {isActionPending ? "Saving..." : actionAvailability.rejected.label}
          </button>
          <button
            onClick={() => onDecision(item.id, "snoozed")}
            disabled={isActionPending || actionAvailability.snoozed.disabled}
            title={actionAvailability.snoozed.reason ?? undefined}
            className="px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {isActionPending ? "Saving..." : actionAvailability.snoozed.label}
          </button>
        </div>
        {disabledReasons.length > 0 && (
          <div className="space-y-1">
            {disabledReasons.map((reason) => (
              <div key={reason} className="text-xs text-[var(--text-muted)]">
                {reason}
              </div>
            ))}
          </div>
        )}
        {actionError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            {actionError}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setShowModal(true)}
            className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium hover:bg-[var(--accent)]/90 transition-colors"
          >
            {t("rdc.escalate")}
          </button>
          <button
            disabled
            className="px-4 py-2 rounded-lg bg-[var(--card)] border border-[var(--border)] text-[var(--text-muted)] text-sm cursor-not-allowed"
          >
            {t("rdc.schedule")}
          </button>
        </div>
      </div>

      {/* Escalation Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl max-w-md w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-[var(--text)]">{t("rdc.escalateToCouncil")}</h3>
              <button
                onClick={() => setShowModal(false)}
                className="text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t("rdc.whyEscalate")}
                </label>
                <textarea
                  className="w-full px-3 py-2 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-sm text-[var(--text)]"
                  rows={2}
                  placeholder="Optional: Why are you escalating this?"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-2">
                  {t("rdc.priority")}
                </label>
                <div className="flex gap-2">
                  <button
                    className="flex-1 px-3 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium"
                    onClick={() => {
                      setShowModal(false);
                      alert("Normal priority item queued for next council session");
                    }}
                  >
                    {t("rdc.normal")}
                  </button>
                  <button
                    className="flex-1 px-3 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700"
                    onClick={() => {
                      setShowModal(false);
                      alert("Urgent council session convened - memo incoming");
                    }}
                  >
                    {t("rdc.urgent")}
                  </button>
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-[var(--border)] flex justify-end gap-2">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function getOperatorHeaders(): HeadersInit {
  if (typeof window === "undefined") return {};
  const token = window.localStorage.getItem("openclaw_operator_token")?.trim();
  return token ? { "x-openclaw-operator-token": token } : {};
}

export default function RDCouncilPage() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState("council");
  const [items, setItems] = useState<CouncilItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const fetchItems = async () => {
      if (!cancelled) {
        setLoading(true);
        setLoadError(null);
      }
      try {
        const response = await fetch("/api/rd-council-items", {
          cache: "no-store",
          headers: getOperatorHeaders(),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) {
          throw new Error(
            typeof data?.message === "string" && data.message.trim() !== ""
              ? data.message
              : response.statusText || "Failed to load R&D Council items."
          );
        }
        if (!cancelled) {
          setItems(Array.isArray(data.items) ? data.items : []);
        }
      } catch (error) {
        console.error("Failed to load R&D Council items:", error);
        if (!cancelled) {
          setItems([]);
          setLoadError(
            error instanceof Error && error.message.trim() !== ""
              ? error.message
              : "Failed to load R&D Council items."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchItems();
    return () => {
      cancelled = true;
    };
  }, [reloadNonce]);

  const submitDecision = async (itemId: string, decision: CouncilDecision) => {
    const key = `${itemId}:${decision}`;
    setActionKey(key);
    setActionErrors((current) => {
      if (!current[itemId]) return current;
      const next = { ...current };
      delete next[itemId];
      return next;
    });
    try {
      const request =
        decision === "approved"
          ? {
              url: "/api/approve-v25",
              body: {
                itemId,
                note: "Approved from the R&D Council dashboard.",
                actor: "rd-council-ui",
              },
            }
          : decision === "rejected"
            ? {
                url: "/api/reject-v25",
                body: {
                  itemId,
                  note: "Rejected from the R&D Council dashboard.",
                  actor: "rd-council-ui",
                },
              }
            : {
                url: `/api/rd-council-items/${encodeURIComponent(itemId)}/snooze`,
                body: {
                  note: "Snoozed from the R&D Council dashboard.",
                  actor: "rd-council-ui",
                  snoozeUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                },
              };

      const response = await fetch(request.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getOperatorHeaders(),
        },
        body: JSON.stringify(request.body),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success || !data?.item) {
        throw new Error(
          getActionErrorMessage(decision, {
            response,
            payload: data,
          })
        );
      }
      setItems((current) => current.map((item) => (item.id === data.item.id ? data.item : item)));
    } catch (error) {
      console.error("Failed to persist R&D Council decision:", error);
      setActionErrors((current) => ({
        ...current,
        [itemId]:
          error instanceof Error && error.message.trim() !== ""
            ? error.message
            : getActionErrorMessage(decision, { error }),
      }));
    } finally {
      setActionKey(null);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] p-4 sm:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-[var(--text)]">R&D Council</h1>
            <p className="text-sm text-[var(--text-muted)] mt-1">
              {t("rdc.description")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="px-3 py-1.5 rounded-lg bg-[var(--accent)]/10 text-[var(--accent)] font-medium text-sm">
              {items.length} {t("rdc.active")}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap gap-2 border-b border-[var(--border)] pb-1">
          {RDCOUNCIL_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}
            >
              {t(tab.label)}
              {tab.id === "council" && <span className="ml-2 text-xs bg-[var(--accent)] text-white px-1.5 py-0.5 rounded-full">{items.length}</span>}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="space-y-4">
          {loading ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-6 py-12 text-center text-[var(--text-muted)]">
              {t("common.loading")}...
            </div>
          ) : loadError ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-6 py-8 text-center space-y-3">
              <div className="text-sm font-medium text-rose-900">Failed to load live R&amp;D Council state</div>
              <div className="text-sm text-rose-800">{loadError}</div>
              <div>
                <button
                  onClick={() => setReloadNonce((current) => current + 1)}
                  className="px-4 py-2 rounded-lg bg-rose-700 text-white text-sm font-medium hover:bg-rose-800 transition-colors"
                >
                  Retry
                </button>
              </div>
            </div>
          ) : activeTab === "council" ? (
            <div className="grid gap-4">
              {items.map((item) => (
                <Card
                  key={item.id}
                  item={item}
                  t={t}
                  onDecision={submitDecision}
                  isActionPending={actionKey !== null && actionKey.startsWith(`${item.id}:`)}
                  actionError={actionErrors[item.id] ?? null}
                />
              ))}
              {items.length === 0 && (
                <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-6 py-12 text-center space-y-2">
                  <div className="text-sm font-medium text-[var(--text)]">No council items are currently queued.</div>
                  <div className="text-sm text-[var(--text-muted)]">
                    The backend returned an empty list, so there is nothing for an operator to review right now.
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-12 text-[var(--text-muted)]">
              {t("rdc.comingSoon")}
            </div>
          )}
        </div>

        {/* Global Memo Panel */}
        <div className="mt-6 border-t border-[var(--border)] pt-6">
          <div className="bg-[var(--accent)]/5 border border-[var(--accent)]/20 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-[var(--text)]">
                {t("rdc.latestMemo")}
              </h2>
              <span className="text-xs text-[var(--text-muted)]">
                {formatTimestamp("2026-03-25T09:00:00Z")}
              </span>
            </div>
            <p className="text-sm text-[var(--text)]">
              {t("rdc.memoPreview")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
