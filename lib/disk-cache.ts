import fs from "fs";
import path from "path";

// API 响应缓存的磁盘持久化：服务重启后立即恢复上一次成功的数据，
// 避免冷启动的首个请求触发分钟级同步重算、阻塞所有请求。
const CACHE_DIR = path.join(process.cwd(), ".api-cache");

export interface CacheEntry<T> {
  data: T;
  ts: number;
}

export function loadDiskCache<T>(name: string): CacheEntry<T> | null {
  try {
    const raw = fs.readFileSync(path.join(CACHE_DIR, `${name}.json`), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.ts === "number" && "data" in parsed) return parsed as CacheEntry<T>;
  } catch {}
  return null;
}

export function saveDiskCache<T>(name: string, entry: CacheEntry<T>): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${name}.json`), JSON.stringify(entry));
  } catch {}
}

// 清除单个磁盘缓存条目：写操作（如切换模型）后调用，避免后续 GET 从磁盘回填旧数据
export function clearDiskCache(name: string): void {
  try {
    fs.unlinkSync(path.join(CACHE_DIR, `${name}.json`));
  } catch {}
}
