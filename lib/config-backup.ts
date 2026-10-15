/**
 * openclaw.json 備份與還原工具模組
 *
 * 功能：
 * 1. 透過 SHA-256 hash 偵測設定檔變更
 * 2. 變更時自動備份上一個版本
 * 3. 列出可用備份
 * 4. 從備份還原
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { OPENCLAW_HOME, OPENCLAW_CONFIG_PATH } from "./openclaw-paths";

// ── 常數 ────────────────────────────────────────────────
const BACKUP_DIR = path.join(OPENCLAW_HOME, "backups", "config");
const HASH_FILE = path.join(BACKUP_DIR, ".last-hash");
const MAX_ROLLING = 8;   // 一般滾動備份保留數
const MIN_GOOD_SIZE = 1024; // 小於此 bytes 視為損毀，不計入錨點

// ── 持久化 hash（讀寫磁碟，重啟後仍有效）────────────────
function readPersistedHash(): string | null {
  try {
    const h = fs.readFileSync(HASH_FILE, "utf-8").trim();
    return h.length === 64 ? h : null; // SHA-256 = 64 hex chars
  } catch {
    return null;
  }
}

function writePersistedHash(hash: string): void {
  try {
    ensureBackupDir();
    fs.writeFileSync(HASH_FILE, hash, "utf-8");
  } catch { /* ignore */ }
}

// ── Hash ────────────────────────────────────────────────
export function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ── 備份目錄初始化 ──────────────────────────────────────
function ensureBackupDir(): void {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

// ── 產生備份檔名 ────────────────────────────────────────
function makeBackupFilename(): string {
  // openclaw.2026-03-15T08-30-00.json
  const ts = new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d+Z$/, "");
  return `openclaw.${ts}.json`;
}

// ── 執行備份（將「目前磁碟上的版本」存到備份資料夾）──────
export function backupCurrentConfig(): { filename: string } | null {
  try {
    const content = fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8");
    ensureBackupDir();
    const filename = makeBackupFilename();
    const dest = path.join(BACKUP_DIR, filename);
    fs.writeFileSync(dest, content, "utf-8");
    pruneOldBackups();
    return { filename };
  } catch {
    return null;
  }
}

// ── 清理備份，保留策略：──────────────────────────────────
//   - 昨天錨點：昨天最後一個正常備份（sizeBytes >= MIN_GOOD_SIZE）
//   - 上週錨點：2~7 天前最後一個正常備份
//   - 滾動視窗：最新 MAX_ROLLING 個（不含上述兩個錨點）
function pruneOldBackups(): void {
  try {
    const files = listBackupFiles(); // 最新在前

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 86400000;
    const weekAgoStart = todayStart - 7 * 86400000;

    const toKeep = new Set<string>();

    // 昨天錨點
    const yesterdayAnchor = files.find((f) => {
      const t = new Date(f.timestamp).getTime();
      return t >= yesterdayStart && t < todayStart && f.sizeBytes >= MIN_GOOD_SIZE;
    });
    if (yesterdayAnchor) toKeep.add(yesterdayAnchor.filename);

    // 上週錨點（2~7 天前）
    const weekAnchor = files.find((f) => {
      const t = new Date(f.timestamp).getTime();
      return t >= weekAgoStart && t < yesterdayStart && f.sizeBytes >= MIN_GOOD_SIZE;
    });
    if (weekAnchor) toKeep.add(weekAnchor.filename);

    // 滾動視窗：最新 MAX_ROLLING 個（錨點不佔名額）
    let rollingCount = 0;
    for (const f of files) {
      if (toKeep.has(f.filename)) continue;
      if (rollingCount < MAX_ROLLING) {
        toKeep.add(f.filename);
        rollingCount++;
      }
    }

    // 刪除不在保留名單的備份
    for (const f of files) {
      if (!toKeep.has(f.filename)) {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f.filename)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

// ── 列出所有備份 ────────────────────────────────────────
export interface BackupEntry {
  filename: string;
  timestamp: string;     // ISO 格式
  sizeBytes: number;
}

export function listBackupFiles(): BackupEntry[] {
  try {
    ensureBackupDir();
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith("openclaw.") && f.endsWith(".json"));

    return files
      .map((filename) => {
        const stat = fs.statSync(path.join(BACKUP_DIR, filename));
        // 從檔名解析時間戳：openclaw.2026-03-15T08-30-00.json
        const tsMatch = filename.match(/^openclaw\.(.+)\.json$/);
        const timestamp = tsMatch
          ? tsMatch[1].replace(/-(\d{2})-(\d{2})$/, ":$1:$2").replace(/T(\d{2})-/, "T$1:")
          : stat.mtime.toISOString();
        return { filename, timestamp, sizeBytes: stat.size };
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp)); // 最新在前
  } catch {
    return [];
  }
}

// ── 從備份還原 ──────────────────────────────────────────
export interface RestoreResult {
  success: boolean;
  message: string;
  restoredFrom?: string;
  backedUpAs?: string;
}

export function restoreFromBackup(filename: string): RestoreResult {
  const backupPath = path.join(BACKUP_DIR, filename);

  // 安全檢查：防止 path traversal
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return { success: false, message: "Invalid filename" };
  }

  if (!fs.existsSync(backupPath)) {
    return { success: false, message: `Backup not found: ${filename}` };
  }

  try {
    // 讀取備份內容並驗證是否為合法 JSON
    const backupContent = fs.readFileSync(backupPath, "utf-8");
    JSON.parse(backupContent); // 驗證 JSON 格式

    // 先備份當前版本（還原前的安全網）
    const currentBackup = backupCurrentConfig();

    // 執行還原
    fs.writeFileSync(OPENCLAW_CONFIG_PATH, backupContent, "utf-8");

    // 還原後持久化 hash，讓下次 polling 不會再觸發備份
    writePersistedHash(computeHash(backupContent));

    return {
      success: true,
      message: `Restored from ${filename}`,
      restoredFrom: filename,
      backedUpAs: currentBackup?.filename,
    };
  } catch (err: any) {
    return { success: false, message: `Restore failed: ${err.message}` };
  }
}

// ── 偵測變更並自動備份（在 /api/config GET 中呼叫）──────
export interface ChangeDetectionResult {
  changed: boolean;
  currentHash: string;
  backedUp: boolean;
  backupFilename?: string;
}

export function detectChangeAndBackup(rawContent: string): ChangeDetectionResult {
  const currentHash = computeHash(rawContent);
  const lastKnownHash = readPersistedHash();

  // 第一次執行（無持久化記錄）：記錄 hash，不觸發備份
  if (lastKnownHash === null) {
    writePersistedHash(currentHash);
    return { changed: false, currentHash, backedUp: false };
  }

  // Hash 未變：無需備份
  if (currentHash === lastKnownHash) {
    return { changed: false, currentHash, backedUp: false };
  }

  // Hash 已變：備份目前版本，更新持久化 hash
  const backup = backupCurrentConfig();
  writePersistedHash(currentHash);

  return {
    changed: true,
    currentHash,
    backedUp: backup !== null,
    backupFilename: backup?.filename,
  };
}

// ── 取得備份目錄路徑（供外部使用）────────────────────────
export function getBackupDir(): string {
  return BACKUP_DIR;
}
