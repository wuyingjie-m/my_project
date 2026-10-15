import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_DASHBOARD_VERSION: (() => {
      try {
        if (!existsSync(join(process.cwd(), ".git"))) return process.env.NEXT_PUBLIC_DASHBOARD_VERSION || "";
        return execSync("git log -1 --format=%cd --date=format:%y.%m%d", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return "";
      }
    })(),
  },
};

export default nextConfig;
