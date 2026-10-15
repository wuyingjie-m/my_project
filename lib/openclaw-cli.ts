import { exec, execFile, execSync } from "child_process";
import crypto from "crypto";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

function quoteShellArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

const EXTRA_PATH =
  process.platform === "win32"
    ? [
        process.env.PATH || "",
        process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : "",
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "openclaw") : "",
        path.join(process.env.SystemRoot || "C:\\Windows", "System32"),
      ].filter(Boolean).join(path.delimiter)
    : `${process.env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;

let _openclawPath: string | null | undefined = undefined;
function findOpenclawPath(): string {
  if (_openclawPath !== undefined) return _openclawPath ?? "openclaw";
  try {
    const cmd = process.platform === "win32" ? "where openclaw" : "which openclaw";
    const env = { ...process.env, PATH: EXTRA_PATH };
    _openclawPath = execSync(cmd, { encoding: "utf8", env }).trim().split("\n")[0].trim();
  } catch {
    _openclawPath = null;
  }
  return _openclawPath ?? "openclaw";
}

export async function execOpenclaw(
  args: string[],
  options: { configPath?: string; gatewayPort?: string | number; gatewayToken?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, FORCE_COLOR: "0", PATH: EXTRA_PATH };
  if (options.configPath) {
    delete env.OPENCLAW_HOME;
    env.OPENCLAW_CONFIG_PATH = options.configPath;
  }
  if (options.gatewayPort !== undefined) {
    env.OPENCLAW_GATEWAY_PORT = String(options.gatewayPort);
  }
  if (options.gatewayToken) {
    env.OPENCLAW_GATEWAY_TOKEN = options.gatewayToken;
  }
  const bin = findOpenclawPath();

  if (process.platform !== "win32") {
    return execFileAsync(bin, args, {
      maxBuffer: 10 * 1024 * 1024,
      env,
      timeout: options.timeoutMs,
    });
  }

  const command = `${quoteShellArg(bin)} ${args.map(quoteShellArg).join(" ")}`;
  return execAsync(command, {
    maxBuffer: 10 * 1024 * 1024,
    env,
    shell: "cmd.exe",
    timeout: options.timeoutMs,
  });
}

export function parseJsonFromMixedOutput(output: string): any {
  for (let i = 0; i < output.length; i++) {
    if (output[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < output.length; j++) {
      const ch = output[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = output.slice(i, j + 1).trim();
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

export function parseOpenclawJsonOutput(stdout: string, stderr = ""): any {
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fallback below.
    }
  }
  return parseJsonFromMixedOutput(`${stdout}\n${stderr}`);
}

export function resolveConfigSnapshotHash(snapshot: { hash?: string; raw?: string | null } | null | undefined): string | null {
  const hash = snapshot?.hash;
  if (typeof hash === "string" && hash.trim()) return hash.trim();
  if (typeof snapshot?.raw !== "string") return null;
  return crypto.createHash("sha256").update(snapshot.raw).digest("hex");
}

export async function callOpenclawGateway(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 10000,
  options: { configPath?: string; gatewayPort?: string | number } = {},
): Promise<any> {
  try {
    const { stdout, stderr } = await execOpenclaw([
      "gateway",
      "call",
      method,
      "--json",
      "--timeout",
      String(timeoutMs),
      "--params",
      JSON.stringify(params),
    ], {
      configPath: options.configPath,
      gatewayPort: options.gatewayPort,
      timeoutMs: timeoutMs + 1000,
    });
    const parsed = parseOpenclawJsonOutput(stdout, stderr);
    if (parsed == null) {
      throw new Error(`Failed to parse Gateway response for ${method}`);
    }
    return parsed;
  } catch (err: any) {
    const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
    const stdout = typeof err?.stdout === "string" ? err.stdout.trim() : "";
    const message = stderr || stdout || err?.message || `Gateway call failed: ${method}`;
    throw new Error(message);
  }
}
