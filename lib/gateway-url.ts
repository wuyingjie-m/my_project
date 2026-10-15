/**
 * Build a gateway URL.
 * - If hostOverride is a full URL (contains "://"), use it as the base directly
 *   (preserving scheme, no port appended). Useful for e.g. "https://openclaw.local".
 * - Otherwise, prefer explicit host override from backend config when provided.
 * - Fallback to current browser hostname for LAN access.
 * - SSR fallback: localhost.
 */
export function buildGatewayUrl(
  port: number,
  path: string,
  params?: Record<string, string>,
  hostOverride?: string,
  proxyInstanceId?: string,
): string {
  const shouldProxy = proxyInstanceId || process.env.NEXT_PUBLIC_OPENCLAW_GATEWAY_PROXY === "1";
  if (shouldProxy) {
    const search = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v) search.set(k, v);
      }
    }
    const query = search.toString();
    return `/openclaw-gateway/${encodeURIComponent(proxyInstanceId || "default")}${path}${query ? `?${query}` : ""}`;
  }

  const base = hostOverride?.trim() || "";
  let url: URL;
  if (base.includes("://")) {
    // Full URL base (e.g. "https://openclaw.local") — use scheme as-is, no port
    const origin = base.replace(/\/$/, "");
    url = new URL(`${origin}${path}`);
  } else {
    const host = base || (typeof window !== "undefined" ? window.location.hostname : "localhost");
    url = new URL(`http://${host}:${port}${path}`);
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }
  }
  return url.toString();
}
