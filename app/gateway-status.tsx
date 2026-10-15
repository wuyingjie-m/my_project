"use client";

import { useEffect, useState, useCallback } from "react";
import { useI18n } from "@/lib/i18n";

function resolveGatewayUrl(url?: string): string | undefined {
  if (!url || typeof window === "undefined") return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost") parsed.hostname = window.location.hostname;
    return parsed.toString();
  } catch { return url; }
}

interface HealthResult {
  ok: boolean;
  error?: string;
  data?: any;
  webUrl?: string;
  openclawVersion?: string;
}

interface LogResult {
  ok: boolean;
  issues: string[];
  lastStallAt: string | null;
  stallActive: boolean;
  recentLines?: string[];
}

interface BackupEntry {
  filename: string;
  timestamp: string;
  sizeBytes: number;
}

interface GatewayStatusProps {
  compact?: boolean;
  className?: string;
  hideIconOnMobile?: boolean;
}

export function GatewayStatus({ compact = false, className = "", hideIconOnMobile = false }: GatewayStatusProps) {
  const { t } = useI18n();
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [logResult, setLogResult] = useState<LogResult | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [showVersionTip, setShowVersionTip] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartMsg, setRestartMsg] = useState<string | null>(null);

  // Config backup/restore state
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);
  const [reloadCountdown, setReloadCountdown] = useState<number | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  // Track consecutive failures to detect persistent config problems
  const [consecutiveDownCount, setConsecutiveDownCount] = useState(0);
  // Config change detection
  const [configLastModified, setConfigLastModified] = useState<string | null>(null);
  const [configPromptDismissed, setConfigPromptDismissed] = useState(false);

  const fetchLogs = useCallback(() => {
    fetch("/api/gateway-logs")
      .then((r) => r.json())
      .then((d: LogResult) => setLogResult(d))
      .catch(() => {});
  }, []);

  const fetchBackups = useCallback(() => {
    fetch("/api/config-backup")
      .then((r) => r.json())
      .then((d) => setBackups(d.backups || []))
      .catch(() => setBackups([]));
  }, []);

  const fetchConfigMtime = useCallback(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => { if (d.configLastModified) setConfigLastModified(d.configLastModified); })
      .catch(() => {});
  }, []);

  const checkHealth = useCallback(() => {
    fetch("/api/gateway-health")
      .then((r) => r.json())
      .then((d: HealthResult) => {
        setHealth(d);
        if (!d.ok) {
          fetchLogs();
          setConsecutiveDownCount((c) => {
            // 第一次失敗就抓備份，讓使用者一開面板就能看到
            if (c === 0) {
              fetchBackups();
              fetchConfigMtime();
            }
            return c + 1;
          });
        } else {
          setConsecutiveDownCount(0);
          setConfigPromptDismissed(false);
        }
      })
      .catch(() => {
        setHealth({ ok: false, error: t("gateway.fetchError") });
        setConsecutiveDownCount((c) => c + 1);
      });
  }, [t, fetchLogs, fetchBackups, fetchConfigMtime]);

  useEffect(() => {
    checkHealth();
    const timer = setInterval(checkHealth, 10000);
    return () => clearInterval(timer);
  }, [checkHealth]);

  const handleDetailClick = useCallback(() => {
    setShowDetail((v) => {
      if (!v) {
        // Opening panel — fetch fresh data
        fetchLogs();
        fetchBackups();
      }
      return !v;
    });
  }, [fetchLogs, fetchBackups]);

  const handleRestart = useCallback(async () => {
    if (restarting) return;
    setRestarting(true);
    setRestartMsg(null);
    try {
      const res = await fetch("/api/gateway-restart", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setRestartMsg(t("gateway.restartSent"));
        setTimeout(() => {
          checkHealth();
          setRestartMsg(null);
          setShowDetail(false);
        }, 4000);
      } else {
        setRestartMsg(t("gateway.restartFailed").replace("{error}", data.error || t("common.unknownError")));
      }
    } catch (err: any) {
      setRestartMsg(t("gateway.restartFailed").replace("{error}", err.message));
    } finally {
      setRestarting(false);
    }
  }, [restarting, checkHealth, t]);

  const handleRestore = useCallback(async (filename: string) => {
    if (restoring) return;
    setRestoring(true);
    setRestoreMsg(null);
    try {
      const res = await fetch("/api/config-backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      const data = await res.json();
      if (data.success) {
        setRestoreMsg(t("gateway.restoreSuccess"));
        // Auto-restart gateway after restore, then countdown to reload
        setTimeout(async () => {
          await fetch("/api/gateway-restart", { method: "POST" }).catch(() => {});
          // Start 5-second countdown
          let count = 5;
          setReloadCountdown(count);
          const tick = setInterval(() => {
            count -= 1;
            if (count <= 0) {
              clearInterval(tick);
              window.location.reload();
            } else {
              setReloadCountdown(count);
            }
          }, 1000);
        }, 500);
      } else {
        setRestoreMsg(`${t("gateway.restoreFailed")}：${data.error || ""}`);
      }
    } catch (err: any) {
      setRestoreMsg(`${t("gateway.restoreFailed")}：${err.message}`);
    } finally {
      setRestoring(false);
    }
  }, [restoring, checkHealth, t]);

  const gatewayTitle = health?.openclawVersion
    ? `OpenClaw ${health.openclawVersion}`
    : "OpenClaw";

  // Determine warning state: gateway alive but Telegram stalled
  const telegramStall = health?.ok && logResult?.stallActive === true;
  const showWarning = telegramStall;
  // Show restart button when: down, or Telegram stalled
  const showRestart = health !== null;
  // 只要 gateway 下線且有備份，就顯示還原清單（不等 3 次失敗）
  const showConfigHint = !health?.ok && backups.length > 0;

  // Detect recent config change: modified within last 5 minutes
  const configRecentlyChanged = (() => {
    if (!configLastModified) return false;
    const mtime = new Date(configLastModified).getTime();
    return Date.now() - mtime < 5 * 60 * 1000;
  })();
  // 只要 gateway 下線 + config 近期有改動，就顯示醒目提示
  const showConfigChangePrompt = !health?.ok && configRecentlyChanged && !configPromptDismissed;

  return (
    <div className={`relative inline-flex items-center gap-1.5 ${className}`.trim()}>
      {/* Gateway link badge */}
      <a
        href={process.env.NEXT_PUBLIC_GATEWAY_CHAT_BASE_URL ?? "/"}
        target="_blank"
        rel="noopener noreferrer"
        title={gatewayTitle}
        onMouseEnter={() => setShowVersionTip(true)}
        onMouseLeave={() => setShowVersionTip(false)}
        onFocus={() => setShowVersionTip(true)}
        onBlur={() => setShowVersionTip(false)}
        className={`inline-flex items-center rounded-full font-medium border hover:bg-cyan-500/30 transition-colors cursor-pointer ${
          compact ? "px-2 py-1 text-[10px]" : "px-2 py-0.5 text-xs"
        } ${
          health?.ok
            ? "bg-cyan-500/25 text-cyan-200 border-cyan-400/45 animate-pulse"
            : "bg-cyan-500/20 text-cyan-300 border-cyan-500/30"
        }`}
      >
        {compact ? "GW" : hideIconOnMobile ? (
          <>
            <span className="md:hidden">Gateway</span>
            <span className="hidden md:inline">🦞 Gateway</span>
          </>
        ) : "🦞 Gateway"}
        <span className="opacity-50 text-[10px]">↗</span>
      </a>

      {showVersionTip && (
        <div className="absolute top-full left-0 mt-1 z-50 px-2 py-1 rounded-md bg-black/80 border border-white/10 text-white text-[10px] whitespace-nowrap shadow-lg pointer-events-none">
          {gatewayTitle}
        </div>
      )}

      {/* Health indicator */}
      {!health ? (
        <span className={compact ? "text-[10px] text-[var(--text-muted)]" : "text-xs text-[var(--text-muted)]"}>--</span>
      ) : health.ok && !showWarning ? (
        <span className={compact ? "text-green-400 text-xs cursor-help" : "text-green-400 text-sm cursor-help"} title={t("gateway.healthy")}>✅</span>
      ) : showWarning ? (
        <span
          className={compact ? "text-yellow-400 text-xs cursor-pointer" : "text-yellow-400 text-sm cursor-pointer"}
          title={t("gateway.telegramStall")}
          onClick={handleDetailClick}
        >⚠️</span>
      ) : (
        <span
          className={compact ? "text-red-400 text-xs cursor-pointer" : "text-red-400 text-sm cursor-pointer"}
          title={health.error || t("gateway.unhealthy")}
          onClick={handleDetailClick}
        >❌</span>
      )}

      {/* Restart button — shown when there's a problem */}
      {showRestart && (
        <button
          onClick={handleDetailClick}
          className={`inline-flex items-center gap-1 rounded-full border font-medium transition-colors ${
            compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"
          } bg-orange-500/20 text-orange-300 border-orange-500/40 hover:bg-orange-500/35 cursor-pointer`}
          title={t("gateway.viewAndRestart")}
        >
          🔄{!compact && ` ${t("gateway.restart")}`}
        </button>
      )}

      {/* Detail panel */}
      {showDetail && (
        <div className="absolute top-full left-0 mt-1 z-50 rounded-lg bg-[var(--card)] border border-[var(--border)] shadow-xl text-xs w-72 overflow-hidden">
          <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
            <span className="font-semibold text-[var(--text)]">{t("gateway.statusTitle")}</span>
            <button onClick={() => setShowDetail(false)} className="text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer">✕</button>
          </div>

          <div className="px-3 py-2 space-y-2">
            {/* Health status */}
            <div className="flex items-center gap-2">
              <span className="text-[var(--text-muted)]">Process：</span>
              <span className={health?.ok ? "text-green-400" : "text-red-400"}>
                {health?.ok ? t("gateway.processRunning") : t("gateway.processDown")}
              </span>
            </div>

            {/* Telegram stall */}
            {logResult && logResult.issues.includes("telegram_stall") && (
              <div className="flex items-start gap-2">
                <span className="text-[var(--text-muted)] shrink-0">Telegram：</span>
                <span className="text-yellow-400">
                  ⚠️ {t("gateway.telegramPolling")}
                  {logResult.lastStallAt && (
                    <span className="text-[var(--text-muted)] ml-1">
                      ({new Date(logResult.lastStallAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })})
                    </span>
                  )}
                </span>
              </div>
            )}

            {/* Subagent timeout */}
            {logResult && logResult.issues.includes("subagent_timeout") && (
              <div className="flex items-center gap-2">
                <span className="text-[var(--text-muted)]">Subagent：</span>
                <span className="text-orange-400">⚠️ {t("gateway.subagentTimeout")}</span>
              </div>
            )}

            {/* Error message when down */}
            {health && !health.ok && health.error && (
              <div className="text-red-300 bg-red-500/10 rounded px-2 py-1.5 leading-relaxed">
                {health.error}
              </div>
            )}

            {/* Log toggle — always visible when gateway is down */}
            {health && !health.ok && (
              <button
                onClick={() => { fetchLogs(); setShowLogs(v => !v); }}
                className="w-full text-left px-2 py-1 rounded text-[11px] text-[var(--text-muted)] bg-white/5 hover:bg-white/10 border border-[var(--border)] transition-colors cursor-pointer"
              >
                {t("gateway.viewLogs")} {showLogs ? "▲" : "▼"}
              </button>
            )}

            {/* Log viewer */}
            {showLogs && (
              <div className="rounded border border-[var(--border)] bg-black/30 px-2 py-2">
                {logResult?.recentLines && logResult.recentLines.length > 0 ? (
                  <pre className="text-[9px] text-red-300/80 leading-relaxed overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-all">
                    {logResult.recentLines.join("\n")}
                  </pre>
                ) : (
                  <p className="text-[10px] text-[var(--text-muted)]">—</p>
                )}
              </div>
            )}

            {/* Config change prompt — prominent banner when config recently changed */}
            {showConfigChangePrompt && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 space-y-2">
                <div className="flex items-start gap-2">
                  <span className="shrink-0 text-base">⚠️</span>
                  <div>
                    <div className="text-amber-300 font-semibold">{t("gateway.noResponse")}</div>
                    <div className="text-[var(--text-muted)] mt-1 leading-relaxed text-[11px]">{t("gateway.configChanged")}</div>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex flex-wrap gap-1.5">
                  {(() => {
                    const recommended = findRecommendedBackup(backups);
                    return recommended ? (
                      <button
                        onClick={() => handleRestore(recommended.filename)}
                        disabled={restoring}
                        className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/35 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                      >
                        {restoring ? t("gateway.restoring") : `${t("gateway.restorePrev")} (${formatBackupTime(recommended.timestamp)}, ${formatSize(recommended.sizeBytes)})`}
                      </button>
                    ) : null;
                  })()}
                  <button
                    onClick={() => setConfigPromptDismissed(true)}
                    className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-white/5 text-[var(--text-muted)] border border-[var(--border)] hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    {t("gateway.dismiss")}
                  </button>
                </div>
              </div>
            )}

            {/* Config error hint + backup restore (when no recent change detected, or dismissed the prompt) */}
            {showConfigHint && !showConfigChangePrompt && (
              <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-2 space-y-2">
                <div className="flex items-start gap-1.5">
                  <span className="shrink-0">📋</span>
                  <div>
                    <div className="text-amber-300 font-medium">{t("gateway.configError")}</div>
                    <div className="text-[var(--text-muted)] mt-0.5 leading-relaxed">{t("gateway.configErrorDesc")}</div>
                  </div>
                </div>

                {/* Backup list */}
                <div className="space-y-1">
                  <div className="text-[var(--text-muted)] text-[10px] uppercase tracking-wider">
                    {t("gateway.backupAvailable")} ({backups.length})
                  </div>
                  {backups.map((b) => {
                    const isRecommended = b.sizeBytes >= 1024;
                    const isSuspect = b.sizeBytes < 1024;
                    return (
                      <div key={b.filename} className={`flex items-center justify-between gap-2 rounded px-1.5 py-1 transition-colors ${isRecommended ? "bg-emerald-500/10 hover:bg-emerald-500/15" : "bg-white/5 hover:bg-white/10"}`}>
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className={`text-[11px] shrink-0 ${isSuspect ? "text-red-400/70 line-through" : "text-[var(--text)]"}`} title={b.filename}>
                            {formatBackupTime(b.timestamp)}
                          </span>
                          <span className={`text-[10px] shrink-0 ${isSuspect ? "text-red-400/60" : "text-[var(--text-muted)]"}`}>
                            {formatSize(b.sizeBytes)}
                          </span>
                          {isRecommended && (
                            <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-medium shrink-0">{t("gateway.backupRecommended")}</span>
                          )}
                          {isSuspect && (
                            <span className="text-[9px] px-1 py-0.5 rounded bg-red-500/20 text-red-400 font-medium shrink-0">{t("gateway.backupSuspect")}</span>
                          )}
                        </div>
                        <button
                          onClick={() => handleRestore(b.filename)}
                          disabled={restoring}
                          className="shrink-0 px-2 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/35 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                        >
                          {restoring ? t("gateway.restoring") : t("gateway.restoreBackup")}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* When gateway is down but no backups available */}
            {!health?.ok && consecutiveDownCount >= 3 && backups.length === 0 && (
              <div className="text-[var(--text-muted)] bg-white/5 rounded px-2 py-1.5 leading-relaxed text-[11px]">
                📋 {t("gateway.noBackups")}
              </div>
            )}

            {/* Restore result message */}
            {restoreMsg && (
              <div className={`rounded px-2 py-1.5 leading-relaxed ${
                restoreMsg.startsWith("✅") ? "text-green-300 bg-green-500/10" : "text-red-300 bg-red-500/10"
              }`}>
                {restoreMsg}
              </div>
            )}

            {/* Countdown to reload */}
            {reloadCountdown !== null && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-emerald-300 font-semibold text-[11px]">
                    🔄 {reloadCountdown} {t("gateway.reloadCountdown")}
                  </span>
                  <button
                    onClick={() => window.location.reload()}
                    className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/35 transition-colors cursor-pointer"
                  >
                    {t("gateway.reloadNow")}
                  </button>
                </div>
                <div className="text-[10px] text-emerald-200/70 leading-relaxed">
                  {t("gateway.reloadHint")}
                </div>
              </div>
            )}

            {/* Restart result message */}
            {restartMsg && (
              <div className={`rounded px-2 py-1.5 leading-relaxed ${
                restartMsg.startsWith("✅") ? "text-green-300 bg-green-500/10" : "text-red-300 bg-red-500/10"
              }`}>
                {restartMsg}
              </div>
            )}
          </div>

          {/* Restart button */}
          <div className="px-3 py-2 border-t border-[var(--border)]">
            <button
              onClick={handleRestart}
              disabled={restarting}
              className="w-full py-1.5 rounded-lg bg-orange-500/20 text-orange-300 border border-orange-500/40 hover:bg-orange-500/35 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer font-medium"
            >
              {restarting ? t("gateway.restarting") : t("gateway.restartGateway")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Format backup timestamp for display: "3/15 08:30" */
function formatBackupTime(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return timestamp;
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const hour = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${month}/${day} ${hour}:${min}`;
  } catch {
    return timestamp;
  }
}

/** Format file size for display */
function formatSize(bytes: number): string {
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

/**
 * Find the recommended backup: the latest one with size >= 1 KB.
 * Small files (< 1024 bytes) are likely broken/empty configs.
 */
function findRecommendedBackup(backups: BackupEntry[]): BackupEntry | null {
  return backups.find((b) => b.sizeBytes >= 1024) ?? null;
}
