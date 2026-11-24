import type { CSSProperties } from "react";

export type TerminalBackgroundMode = "cover" | "contain" | "tile";
export type TerminalFontWeight = "normal" | "500" | "600" | "700";

const MAX_IMAGE_DATA_LENGTH = 512 * 1024;
const IMAGE_DATA = /^data:image\/(?:webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

export function sanitizeTerminalBackgroundImage(value: unknown): string {
  return typeof value === "string" &&
    value.length <= MAX_IMAGE_DATA_LENGTH &&
    IMAGE_DATA.test(value)
    ? value
    : "";
}

export function sanitizeTerminalFontNames(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .slice(0, 180)
    .split(",")
    .map((font) => font.trim().replace(/^["']|["']$/g, ""))
    .filter((font) => /^[\p{L}\p{M}\p{N} ._-]+$/u.test(font))
    .join(", ");
}

export function terminalWallpaperStyle(
  image: string,
  mode: TerminalBackgroundMode,
  opacity: number,
): CSSProperties {
  if (!image) return {};
  return {
    "--terminal-wallpaper-image": `url("${image}")`,
    "--terminal-wallpaper-size": mode === "tile" ? "auto" : mode,
    "--terminal-wallpaper-repeat": mode === "tile" ? "repeat" : "no-repeat",
    "--terminal-wallpaper-opacity": opacity / 100,
  } as CSSProperties;
}

export async function prepareTerminalBackground(file: File): Promise<string> {
  if (!/^image\/(?:png|jpeg|webp)$/.test(file.type) || file.size > 20 * 1024 * 1024) {
    throw new Error("请选择 20 MB 以内的 PNG、JPEG 或 WebP 图片");
  }
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境无法处理背景图片");
    for (const factor of [1, 0.7, 0.45, 0.25]) {
      canvas.width = Math.max(1, Math.round(image.width * scale * factor));
      canvas.height = Math.max(1, Math.round(image.height * scale * factor));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = sanitizeTerminalBackgroundImage(canvas.toDataURL("image/webp", 0.75));
      if (data) return data;
      const fallback = sanitizeTerminalBackgroundImage(canvas.toDataURL("image/jpeg", 0.7));
      if (fallback) return fallback;
    }
    throw new Error("背景图片无法压缩到可保存的大小");
  } finally {
    image.close();
  }
}
