"use client";

import { useState, useCallback, useEffect } from "react";
import { useI18n } from "@/lib/i18n";
import { commands, type CommandConfig } from "./commands";
import Link from "next/link";

// Icons
const Icons = {
  Refresh: () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/>
    </svg>
  ),
  Check: () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  X: () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  ),
  Search: () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  ),
  Info: () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
  ),
  Terminal: () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
    </svg>
  ),
};

const Button: React.FC<{
  config: CommandConfig;
  isLoading: boolean;
  onClick: () => void;
  disabled: boolean;
}> = ({ config, isLoading, onClick, disabled }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || isLoading}
      className={`flex items-center justify-center gap-2 px-4 py-2 rounded-md font-medium transition-all focus:outline-none w-full sm:w-auto text-sm ${
        isLoading ? 'opacity-50 cursor-wait' : ''
      } ${
        config.variant === 'primary' ? 'bg-blue-600 hover:bg-blue-700 text-white' :
        config.variant === 'success' ? 'bg-green-600 hover:bg-green-700 text-white' :
        config.variant === 'danger' ? 'bg-red-600 hover:bg-red-700 text-white' :
        'bg-gray-600 hover:bg-gray-700 text-white'
      }`}
    >
      {isLoading ? (
        <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
      ) : (
        config.icon
      )}
      {config.label}
    </button>
  );
};

// Status badges for improvement items
const StatusBadge: React.FC<{ status: "Pending" | "Approved" | "Rejected" }> = ({ status }) => {
  const styles = {
    Pending: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    Approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
    Rejected: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  };

  return (
    <span className={`px-2.5 py-0.5 rounded text-xs font-medium ${styles[status] || styles.Pending}`}>
      {status}
    </span>
  );
};

interface Project {
  id: string;
  title: string;
  description: string;
  status: "Pending" | "Approved" | "Rejected";
  date: string;
  tasks: any[];
}

function getOperatorHeaders(): HeadersInit {
  if (typeof window === "undefined") return {};
  const token = window.localStorage.getItem("openclaw_operator_token")?.trim();
  return token ? { "x-openclaw-operator-token": token } : {};
}

export default function SelfImprovementPage() {
  const { t } = useI18n();
  const [isLoading, setIsLoading] = useState<Record<string, boolean>>({});
  const [lastResult, setLastResult] = useState<{ success: boolean; message: string; version?: string; details?: unknown } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);

  // Load projects on mount
  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const response = await fetch("/api/projects", { headers: getOperatorHeaders() });
        const data = await response.json().catch(() => ({ success: false, message: 'Invalid JSON response from command API' }));
        if (!response.ok || !data.success) {
          throw new Error(data.message || data.error || `Project API failed (${response.status})`);
        }
        setProjects(Array.isArray(data.projects) ? data.projects : []);
        setProjectError(null);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Failed to load projects';
        setProjectError(errorMsg);
        setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ❌ Load projects: ${errorMsg}`, ...prev].slice(0, 50));
      } finally {
        setLoadingProjects(false);
      }
    };
    fetchProjects();
  }, []);

  const executeCommand = useCallback(async (config: CommandConfig) => {
    if (isLoading[config.id]) return;
    if (config.requiresConfirmation && !window.confirm(config.confirmationText || `Are you sure you want to ${config.label}?`)) return;

    const started = new Date();
    setIsLoading((prev) => ({ ...prev, [config.id]: true }));
    setLogs((prev) => [`[${started.toLocaleTimeString()}] ▶ ${config.label}: started`, ...prev].slice(0, 50));

    try {
      const response = await fetch(config.endpoint, {
        method: config.method,
        headers: {
          'Content-Type': 'application/json',
          ...getOperatorHeaders(),
        },
        body: JSON.stringify({ timestamp: started.toISOString(), confirm: config.requiresConfirmation }),
      });

      const data = await response.json().catch(() => ({ success: false, message: 'Invalid JSON response from command API' }));

      if (!response.ok || data.success === false) {
        throw new Error(data.message || data.error || `Command failed (${response.status})`);
      }

      setLastResult({
        success: true,
        message: data.message || 'Command completed successfully',
        version: data.version,
        details: data.details,
      });
      const durationMs = Date.now() - started.getTime();
      const outputLines = Array.isArray(data.log_lines) ? data.log_lines : String(data.output || data.message || '').split('\n').filter(Boolean);
      setLogs((prev) => [
        `[${new Date().toLocaleTimeString()}] ✅ ${config.label}: ${data.message} (${durationMs}ms)`,
        ...outputLines.map((line: string) => `  ${line}`),
        ...prev,
      ].slice(0, 80));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      setLastResult({ success: false, message: errorMsg });
      setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ❌ ${config.label}: ${errorMsg}`, ...prev].slice(0, 80));
    } finally {
      setIsLoading((prev) => ({ ...prev, [config.id]: false }));
    }
  }, [isLoading]);

  return (
    <div className="min-h-screen bg-[var(--bg)] p-4 sm:p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[var(--border)] pb-6">
          <div>
            <h1 className="text-2xl font-bold text-[var(--text)]">Self-Improvement Protocol</h1>
            <p className="text-sm text-[var(--text-muted)] mt-1">
              {t("selfImprovement.subtitle")}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={lastResult?.success ? "Approved" : lastResult ? "Rejected" : "Pending"} />
            <span className="text-xs text-[var(--text-muted)] font-mono">
              {lastResult?.version ? `v${lastResult.version}` : 'v2.4.0'}
            </span>
          </div>
        </header>

        {/* Projects List */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              {t("selfImprovement.projects")}
            </h2>
            <span className="text-xs text-[var(--text-muted)]">
              {projects.length} total
            </span>
          </div>

          <div className="space-y-3">
            {loadingProjects ? (
              <div className="text-center py-12 text-[var(--text-muted)]">
                Loading projects...
              </div>
            ) : projects.length === 0 ? (
              <div className="text-center py-12 text-[var(--text-muted)]">
                {projectError ? `Failed to load projects: ${projectError}` : 'No improvement projects found'}
              </div>
            ) : (
              projects.map((project) => (
                <div key={project.id} className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <h3 className="text-lg font-semibold text-[var(--text)]">{project.title}</h3>
                      <p className="text-sm text-[var(--text-muted)] mt-1 max-w-2xl">{project.description}</p>
                    </div>
                    <StatusBadge status={project.status} />
                  </div>
                  <div className="mt-4 flex items-center gap-4 text-xs text-[var(--text-muted)]">
                    <span>
                      {project.tasks.length} tasks
                      {project.tasks.some((t: any) => t.status === "completed")
                        ? ` • ${project.tasks.filter((t: any) => t.status === "completed").length} completed`
                        : ""
                      }
                    </span>
                    <span>•</span>
                    <span>Updated: {new Date(project.date).toLocaleDateString()}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Action Grid */}
        <section>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {commands.map((cmd) => (
              <div key={cmd.id} className="space-y-2">
                <Button
                  config={cmd}
                  isLoading={Boolean(isLoading[cmd.id])}
                  onClick={() => executeCommand(cmd)}
                  disabled={false}
                />
                <p className="text-xs text-[var(--text-muted)] leading-snug">{cmd.description}</p>
                {cmd.sideEffect !== 'none' ? (
                  <p className="text-[10px] uppercase tracking-wide text-amber-500">Requires confirmation</p>
                ) : null}
              </div>
            ))}

          </div>
        </section>

        {/* Terminal Output */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              {t("selfImprovement.terminal")}
            </h2>
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <Icons.Terminal />
              <span>{logs.length} retained lines</span>
            </div>
          </div>
          <div className="bg-[var(--bg)] border border-[var(--border)] rounded-md p-4 h-64 overflow-y-auto">
            {logs.length === 0 ? (
              <div className="text-[var(--text-muted)] italic">No commands executed yet</div>
            ) : (
              <div className="space-y-2">
                {logs.map((log, i) => (
                  <div key={i} className="text-xs font-mono break-words">
                    {log}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Footer */}
        <footer className="pt-6 border-t border-[var(--border)] text-center text-xs text-[var(--text-muted)]">
          <p>Self-Improvement Dashboard &copy; {new Date().getFullYear()}</p>
          <Link href="/" className="text-[var(--accent)] hover:underline mt-2 inline-block">
            ← {t("common.backHome")}
          </Link>
        </footer>
      </div>
    </div>
  );
}
