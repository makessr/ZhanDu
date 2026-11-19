import { readFileSync } from "node:fs";

interface UpdaterPlatform {
  signature?: unknown;
  url?: unknown;
}

interface UpdaterManifest {
  platforms?: unknown;
  version?: unknown;
}

const REQUIRED_PLATFORM_GROUPS = [
  {
    keys: ["darwin-aarch64-app", "darwin-aarch64"],
    label: "macOS Apple Silicon",
  },
  {
    keys: ["darwin-x86_64-app", "darwin-x86_64"],
    label: "macOS Intel",
  },
  {
    keys: ["linux-x86_64-deb"],
    label: "Linux x64",
  },
  {
    keys: ["linux-aarch64-deb"],
    label: "Linux ARM64",
  },
  {
    keys: [
      "windows-x86_64-nsis",
      "windows-x86_64-msi",
      "windows-x86_64",
    ],
    label: "Windows x64",
  },
  {
    keys: ["windows-aarch64-nsis", "windows-aarch64"],
    label: "Windows ARM64",
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectedVersionFromTag(releaseTag: string) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(releaseTag)) {
    throw new Error(`版本标签“${releaseTag}”格式无效`);
  }
  return releaseTag.slice(1);
}

function validatePlatform(
  key: string,
  value: unknown,
  releaseTag: string,
  repository: string,
) {
  if (!isRecord(value)) {
    throw new Error(`更新清单平台 ${key} 格式无效`);
  }

  const platform = value as UpdaterPlatform;
  if (typeof platform.signature !== "string" || !platform.signature.trim()) {
    throw new Error(`更新清单平台 ${key} 缺少签名`);
  }
  if (typeof platform.url !== "string" || !platform.url.trim()) {
    throw new Error(`更新清单平台 ${key} 缺少下载地址`);
  }

  let url: URL;
  try {
    url = new URL(platform.url);
  } catch {
    throw new Error(`更新清单平台 ${key} 的下载地址无效`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`更新清单平台 ${key} 的下载地址必须使用 HTTPS`);
  }
  const match = url.pathname.match(
    /^\/([\w.-]+\/[\w.-]+)\/releases\/download\/([^/]+)\/[^/]+$/,
  );
  if (url.origin !== "https://github.com" || !match || match[2] !== releaseTag) {
    throw new Error(
      `更新清单平台 ${key} 必须使用当前版本的 GitHub Release 公开下载地址`,
    );
  }
  if (match[1].toLowerCase() !== repository.toLowerCase()) {
    throw new Error(`更新清单平台 ${key} 的下载地址必须属于发布仓库 ${repository}`);
  }
}

export function validateUpdaterManifest(
  value: unknown,
  releaseTag: string,
  repository: string,
  platformSet: "all" | "windows" = "all",
) {
  if (!isRecord(value)) throw new Error("更新清单格式无效");

  const manifest = value as UpdaterManifest;
  const expectedVersion = expectedVersionFromTag(releaseTag);
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `更新清单版本不一致：期望 ${expectedVersion}，实际 ${String(manifest.version)}`,
    );
  }
  if (!isRecord(manifest.platforms)) {
    throw new Error("更新清单缺少 platforms 对象");
  }

  Object.entries(manifest.platforms).forEach(([key, platform]) => {
    validatePlatform(key, platform, releaseTag, repository);
  });

  const required = platformSet === "windows"
    ? REQUIRED_PLATFORM_GROUPS.filter(({ label }) => label.startsWith("Windows"))
    : REQUIRED_PLATFORM_GROUPS;
  const matchedPlatforms = required.map(({ keys, label }) => {
    const key = keys.find((candidate) => candidate in manifest.platforms!);
    if (!key) {
      throw new Error(
        `更新清单缺少 ${label}，需要以下平台键之一：${keys.join(", ")}`,
      );
    }
    return key;
  });

  return matchedPlatforms;
}

if (import.meta.main) {
  try {
    const manifestPath = process.argv[2];
    const releaseTag = process.argv[3] ?? "";
    const repository = process.argv[4];
    const platformSet = process.argv[5] ?? "all";
    if (!manifestPath) throw new Error("缺少 latest.json 路径");
    if (!repository) throw new Error("缺少发布仓库（owner/repo）");
    if (platformSet !== "all" && platformSet !== "windows") throw new Error("发布平台范围无效");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const platforms = validateUpdaterManifest(manifest, releaseTag, repository, platformSet);
    console.log(`更新清单校验通过：${platforms.join(", ")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
