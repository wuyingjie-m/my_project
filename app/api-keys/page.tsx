"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

type Member = { instanceId: string; instanceName: string; agentId: string; name: string; source: string };
type Pool = { provider: string; keyTail: string; keyLen: number; members: Member[] };
type AvailableKey = { tail: string; owner: string };
type KeyData = { pools: Pool[]; availableKeys: AvailableKey[] };

export default function ApiKeysPage() {
  const { t } = useI18n();
  const [data, setData] = useState<KeyData | null>(null);
  const [instanceId, setInstanceId] = useState<string>("");
  const [selectedTail, setSelectedTail] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => {
    fetch("/api/agent-key", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (d && d.pools) setData(d); })
      .catch(() => {});
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!instanceId && data?.pools?.length) {
      const first = data.pools.flatMap((p) => p.members).find((m) => m.instanceId);
      if (first) setInstanceId(first.instanceId);
    }
  }, [data, instanceId]);

  const instances = Array.from(new Set((data?.pools ?? []).flatMap((p) => p.members.map((m) => m.instanceId))));
  const targetAgents = Array.from(
    new Set(
      (data?.pools ?? [])
        .flatMap((p) => p.members)
        .filter((m) => m.instanceId === instanceId)
        .map((m) => m.agentId),
    ),
  );
  // 当前实例正在使用的 key（取首个 agent 的指纹）
  const currentTail = (data?.pools ?? []).find((p) => p.members.some((m) => m.instanceId === instanceId))?.keyTail || "";
  const currentOwner = (data?.availableKeys ?? []).find((k) => k.tail === currentTail)?.owner || "";

  async function apply() {
    if (!instanceId || !selectedTail || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/agent-key", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceId, keyTail: selectedTail }),
      });
      const d = await r.json();
      if (d.ok) {
        setMsg({ ok: true, text: `${t("apiKeys.applied")} …${selectedTail}（${d.applied}/${d.total}）` });
        load();
      } else {
        const bad = (d.results || []).filter((x: any) => !x.ok).map((x: any) => `${x.agentId}: ${x.error || "?"}`).join("; ");
        setMsg({ ok: false, text: `${t("apiKeys.failed")} — ${bad || d.error || ""}`.slice(0, 240) });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e).slice(0, 200) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-3 md:p-4 max-w-6xl mx-auto">
      <div className="mb-4">
        <h1 className="text-xl font-bold flex items-center gap-2">🔑 {t("apiKeys.title")}</h1>
        <p className="text-[var(--text-muted)] text-xs mt-0.5">{t("apiKeys.desc")}</p>
      </div>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--card)]/50 p-3 md:p-4">
        {/* 实例选择 */}
        <div className="mb-3 flex flex-wrap items-center gap-1">
          {instances.map((id) => (
            <button key={id} type="button" onClick={() => { setInstanceId(id); setSelectedTail(""); setMsg(null); }}
              className={`rounded-full px-2.5 py-1 text-xs transition ${instanceId === id ? "bg-[var(--accent)] font-medium text-[var(--bg)]" : "border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"}`}>
              {id.replace("openclaw_", "")}
            </button>
          ))}
        </div>
        {instanceId && (
          <div className="mb-3 text-[11px] text-[var(--text-muted)]">
            {t("apiKeys.members")}: {targetAgents.join(", ") || "-"}
            {currentTail && <>　·　{t("apiKeys.current")}: …{currentTail}{currentOwner ? `（${t("apiKeys.owner")}：${currentOwner}）` : ""}</>}
          </div>
        )}

        {/* Key 选择列表 */}
        {instanceId && (
          <div className="mb-3 space-y-1.5">
            <div className="text-[11px] text-[var(--text-muted)]">{t("apiKeys.selectKey")}</div>
            {(data?.availableKeys ?? []).map((k) => {
              const isCurrent = k.tail === currentTail;
              const selected = selectedTail === k.tail;
              return (
                <button key={k.tail} type="button"
                  onClick={() => setSelectedTail(isCurrent ? selectedTail : k.tail)}
                  className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition ${
                    selected ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)] bg-[var(--bg)] hover:border-[var(--text-muted)]"}`}>
                  <span className={`inline-block h-3 w-3 shrink-0 rounded-full border ${selected ? "border-[var(--accent)] bg-[var(--accent)]" : "border-[var(--text-muted)]"}`} />
                  <span className="font-mono font-semibold text-[var(--text)]">…{k.tail}</span>
                  <span className="text-[var(--text-muted)]">{t("apiKeys.owner")}：{k.owner}</span>
                  {isCurrent && (
                    <span className="ml-auto rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-400">{t("apiKeys.current")}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button type="button" onClick={apply} disabled={busy || !selectedTail || !instanceId || selectedTail === currentTail}
            className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-xs font-medium text-[var(--bg)] disabled:opacity-40">
            {busy ? "…" : t("apiKeys.apply")}
          </button>
          {selectedTail === currentTail && currentTail && (
            <span className="text-[10px] text-[var(--text-muted)]">{t("apiKeys.alreadyUsing")}</span>
          )}
          {msg && <span className={`text-xs ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</span>}
        </div>
      </section>

      {/* Key 池总览 */}
      <section className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--card)]/50 p-3 md:p-4">
        <h2 className="mb-2 text-sm font-semibold text-[var(--text)]">{t("apiKeys.poolTitle")}</h2>
        <div className="space-y-2">
          {(data?.pools ?? []).map((p) => (
            <div key={`${p.provider}:${p.keyTail}`} className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-2.5">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono font-semibold text-[var(--text)]">…{p.keyTail}</span>
                <span className="text-[10px] text-[var(--text-muted)]">{p.provider}</span>
                <span className="ml-auto text-[10px] text-[var(--text-muted)]">{p.members.length} agent</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {p.members.map((m) => (
                  <span key={`${m.instanceId}:${m.agentId}`} className="rounded bg-[var(--card)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                    {m.instanceName.replace("openclaw_", "")}/{m.name}
                  </span>
                ))}
              </div>
            </div>
          ))}
          {!data && <div className="p-3 text-center text-xs text-[var(--text-muted)]">…</div>}
        </div>
      </section>
    </div>
  );
}
