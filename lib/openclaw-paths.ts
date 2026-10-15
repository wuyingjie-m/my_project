import os from "os";
import path from "path";

const home = os.homedir();

function defaultOpenClawHome(): string {
  if (process.env.OPENCLAW_HOME) return process.env.OPENCLAW_HOME;
  return path.join(home, ".openclaw");
}

export const OPENCLAW_HOME = defaultOpenClawHome();
export const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || path.join(OPENCLAW_HOME, "openclaw.json");
export const OPENCLAW_AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR || path.join(path.dirname(OPENCLAW_CONFIG_PATH), "agents");
export const OPENCLAW_PIXEL_OFFICE_DIR = path.join(OPENCLAW_HOME, "pixel-office");

function uniquePaths(paths: Array<string | undefined>): string[] {
  return Array.from(new Set(paths.filter((value): value is string => Boolean(value && value.trim()))));
}

export function getOpenclawPackageCandidates(version = process.version): string[] {
  const appData = process.env.APPDATA;
  const homebrewPrefix = process.env.HOMEBREW_PREFIX;
  const npmPrefix = process.env.npm_config_prefix || process.env.PREFIX;

  return uniquePaths([
    process.env.OPENCLAW_PACKAGE_DIR,
    path.join(home, ".local", "lib", "node_modules", "openclaw"),
    npmPrefix ? path.join(npmPrefix, "node_modules", "openclaw") : undefined,
    path.join(home, ".nvm", "versions", "node", version, "lib", "node_modules", "openclaw"),
    path.join(home, ".fnm", "node-versions", version, "installation", "lib", "node_modules", "openclaw"),
    path.join(home, ".npm-global", "lib", "node_modules", "openclaw"),
    path.join(home, ".local", "share", "pnpm", "global", "5", "node_modules", "openclaw"),
    path.join(home, "Library", "pnpm", "global", "5", "node_modules", "openclaw"),
    appData ? path.join(appData, "npm", "node_modules", "openclaw") : undefined,
    homebrewPrefix ? path.join(homebrewPrefix, "lib", "node_modules", "openclaw") : undefined,
    "/opt/homebrew/lib/node_modules/openclaw",
    "/usr/local/lib/node_modules/openclaw",
    "/usr/lib/node_modules/openclaw",
  ]);
}
