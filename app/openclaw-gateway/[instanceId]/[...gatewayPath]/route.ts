import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { OPENCLAW_CONFIG_PATH, OPENCLAW_HOME } from "@/lib/openclaw-paths";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type InstanceConfig = {
  id: string;
  configPath: string;
  config: any;
};

function instancesDir(): string {
  return process.env.OPENCLAW_INSTANCES_DIR || (process.platform === "linux" ? "/data/agent" : path.join(OPENCLAW_HOME, "instances"));
}

function isSafeInstanceId(instanceId: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(instanceId);
}

function loadInstanceConfig(instanceId: string): InstanceConfig | null {
  if (!isSafeInstanceId(instanceId)) return null;

  const candidates = instanceId === "default"
    ? [OPENCLAW_CONFIG_PATH]
    : [
        path.join(instancesDir(), instanceId, ".openclaw", "openclaw.json"),
        path.join(instancesDir(), instanceId, "openclaw.json"),
      ];

  for (const configPath of candidates) {
    try {
      if (!fs.existsSync(configPath)) continue;
      return {
        id: instanceId,
        configPath,
        config: JSON.parse(fs.readFileSync(configPath, "utf-8")),
      };
    } catch {}
  }

  return null;
}

function targetUrl(instance: InstanceConfig, gatewayPath: string[], request: NextRequest): string {
  const gatewayPort = instance.config?.gateway?.port || 18789;
  const url = new URL(`http://127.0.0.1:${gatewayPort}/${gatewayPath.map(encodeURIComponent).join("/")}`);
  for (const [key, value] of request.nextUrl.searchParams.entries()) {
    url.searchParams.append(key, value);
  }
  const token = instance.config?.gateway?.auth?.token;
  if (typeof token === "string" && token && !url.searchParams.has("token") && gatewayPath[0] === "chat") {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

async function proxyGateway(
  request: NextRequest,
  context: { params: Promise<{ instanceId: string; gatewayPath: string[] }> },
): Promise<Response> {
  const { instanceId, gatewayPath } = await context.params;
  const instance = loadInstanceConfig(instanceId);
  if (!instance) {
    return NextResponse.json({ error: `Unknown OpenClaw instance: ${instanceId}` }, { status: 404 });
  }

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  headers.delete("accept-encoding");
  const clientIp = request.headers.get("x-real-ip") || "127.0.0.1";
  const forwardedHost = request.headers.get("host") || request.nextUrl.host;
  const forwardedProto = request.headers.get("x-forwarded-proto") || request.nextUrl.protocol.replace(":", "") || "http";
  headers.delete("forwarded");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  headers.set("x-forwarded-for", clientIp);
  headers.set("x-forwarded-host", forwardedHost);
  headers.set("x-forwarded-proto", forwardedProto);
  headers.set("x-real-ip", clientIp);

  const token = instance.config?.gateway?.auth?.token;
  if (typeof token === "string" && token && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token}`);
  }

  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : Buffer.from(await request.arrayBuffer());

  const upstream = await fetch(targetUrl(instance, gatewayPath, request), {
    method: request.method,
    headers,
    body,
    redirect: "manual",
    cache: "no-store",
  });

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("transfer-encoding");

  const location = responseHeaders.get("location");
  if (location) {
    try {
      const rewritten = new URL(location, targetUrl(instance, gatewayPath, request));
      if (rewritten.hostname === "127.0.0.1" || rewritten.hostname === "localhost") {
        responseHeaders.set("location", `/openclaw-gateway/${encodeURIComponent(instanceId)}${rewritten.pathname}${rewritten.search}`);
      }
    } catch {}
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = proxyGateway;
export const POST = proxyGateway;
export const PUT = proxyGateway;
export const PATCH = proxyGateway;
export const DELETE = proxyGateway;
