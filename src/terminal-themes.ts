import type { ITheme } from "@xterm/xterm";
import type { ResolvedAppearance } from "./appearance";
import base24 from "./terminal-base24.json";

export interface TerminalThemeDefinition {
  label: string;
  swatch: string;
  theme: ITheme & { background: string; foreground: string };
}

export const TERMINAL_THEMES = {
  fineshellDark: {
    label: "栈渡深色",
    swatch: "#18181b",
    theme: {
      background: "#18181b",
      foreground: "#d7dae0",
      cursor: "#23c343",
      cursorAccent: "#18181b",
      selectionBackground: "#3b4354",
      black: "#1d2129",
      red: "#f53f3f",
      green: "#23c343",
      yellow: "#f7ba1e",
      blue: "#4080ff",
      magenta: "#b37feb",
      cyan: "#0fc6c2",
      white: "#c9cdd4",
      brightBlack: "#8996a8",
      brightRed: "#fb7a7a",
      brightGreen: "#76da8a",
      brightYellow: "#fadc6d",
      brightBlue: "#94bfff",
      brightMagenta: "#d6a6ff",
      brightCyan: "#7be0dc",
      brightWhite: "#f2f3f5",
    },
  },
  graphiteLight: {
    label: "石墨浅色",
    swatch: "#f7f8fa",
    theme: {
      background: "#f7f8fa",
      foreground: "#1d2129",
      cursor: "#165dff",
      cursorAccent: "#f7f8fa",
      selectionBackground: "#bedaff",
      black: "#1d2129",
      red: "#cb2634",
      green: "#008f2c",
      yellow: "#9a6700",
      blue: "#165dff",
      magenta: "#8f3bb8",
      cyan: "#007a8a",
      white: "#495566",
      brightBlack: "#586576",
      brightRed: "#bc2431",
      brightGreen: "#00752e",
      brightYellow: "#815800",
      brightBlue: "#0e42d2",
      brightMagenta: "#8736ac",
      brightCyan: "#006c78",
      brightWhite: "#354151",
    },
  },
  solarizedDark: {
    label: "Solarized 深色",
    swatch: "#002b36",
    theme: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#2aa198",
      cursorAccent: "#002b36",
      selectionBackground: "#0b4652",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#93a1a1",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#94b8b8",
      brightWhite: "#fdf6e3",
    },
  },
  dracula: {
    label: "Dracula",
    swatch: "#282a36",
    theme: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#50fa7b",
      cursorAccent: "#282a36",
      selectionBackground: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#8be9fd",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  deepOcean: {
    label: "深海蓝",
    swatch: "#101b2b",
    theme: {
      background: "#101b2b",
      foreground: "#e0edf9",
      cursor: "#77dddf",
      cursorAccent: "#101b2b",
      selectionBackground: "#304967",
      black: "#172338",
      red: "#f98292",
      green: "#77d9a3",
      yellow: "#ebc477",
      blue: "#85b3ff",
      magenta: "#c7a7f5",
      cyan: "#69d3db",
      white: "#c4d6e8",
      brightBlack: "#8198b1",
      brightRed: "#ffadb8",
      brightGreen: "#a3ebbc",
      brightYellow: "#ffdb96",
      brightBlue: "#aecbff",
      brightMagenta: "#dec3ff",
      brightCyan: "#a0edf1",
      brightWhite: "#f3f9ff",
    },
  },
} satisfies Record<string, TerminalThemeDefinition>;

export const ANSI_COLOR_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
  "brightMagenta", "brightCyan", "brightWhite",
] as const;

export type TerminalColorScheme =
  | "appearance" | keyof typeof TERMINAL_THEMES | `base24:${string}` | `ghostty:${string}`;

export interface StoredTerminalTheme {
  name: string;
  theme: TerminalThemeDefinition["theme"];
}

export const MAX_CUSTOM_TERMINAL_THEMES = 256;
const HEX_COLOR = /^#?[0-9a-f]{6}$/i;
const GHOSTTY_COLOR_KEYS = {
  background: "background",
  foreground: "foreground",
  "cursor-color": "cursor",
  "cursor-text": "cursorAccent",
  "selection-background": "selectionBackground",
  "selection-foreground": "selectionForeground",
} as const;

export function customTerminalThemeId(name: string): `ghostty:${string}` {
  return `ghostty:${name}`;
}

function terminalColors(
  background: string,
  foreground: string,
  palette: readonly string[],
): TerminalThemeDefinition["theme"] {
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    ...Object.fromEntries(ANSI_COLOR_KEYS.map((key, index) => [key, palette[index]])),
  };
}

export const BASE24_TERMINAL_THEMES = new Map(
  Object.entries(base24).map(([slug, [label, author, background, foreground, selectionBackground, ...palette]]) => [
    `base24:${slug}`,
    {
      label,
      author,
      swatch: background,
      theme: { ...terminalColors(background, foreground, palette), selectionBackground },
    },
  ]),
);

export function parseGhosttyTheme(fileName: string, contents: string): StoredTerminalTheme {
  if (contents.length > 64 * 1024) throw new Error("主题文件超过 64 KB");
  const name = fileName.replace(/\.(?:ghostty|conf|txt)$/i, "").trim();
  if (!name || name.length > 255 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error("主题文件名无效");
  }
  const colors: Partial<ITheme> = {};
  for (const line of contents.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (key === "palette") {
      const entry = /^(0|[1-9]\d*)\s*=\s*(#?[0-9a-f]{6})$/i.exec(value);
      const ansiKey = entry && ANSI_COLOR_KEYS[Number(entry[1])];
      if (ansiKey && entry) colors[ansiKey] = `#${entry[2].replace(/^#/, "")}`.toLowerCase();
    } else if (Object.prototype.hasOwnProperty.call(GHOSTTY_COLOR_KEYS, key) && HEX_COLOR.test(value)) {
      colors[GHOSTTY_COLOR_KEYS[key as keyof typeof GHOSTTY_COLOR_KEYS]] =
        `#${value.replace(/^#/, "")}`.toLowerCase();
    }
  }
  if (!Object.keys(colors).length) throw new Error("文件中没有可用的 Ghostty 十六进制颜色");
  const fallback = TERMINAL_THEMES.fineshellDark.theme;
  const background = colors.background ?? fallback.background;
  const foreground = colors.foreground ?? fallback.foreground;
  return {
    name,
    theme: {
      ...fallback, ...colors, background, foreground,
      cursor: colors.cursor ?? foreground,
      cursorAccent: colors.cursorAccent ?? background,
    },
  };
}

export function sanitizeCustomTerminalThemes(input: unknown): StoredTerminalTheme[] {
  if (!Array.isArray(input)) return [];
  const result = new Map<string, StoredTerminalTheme>();
  for (const item of input.slice(0, MAX_CUSTOM_TERMINAL_THEMES)) {
    if (!item || typeof item.name !== "string" || !item.name.trim() ||
        item.name.length > 255 || /[\x00-\x1f\x7f]/.test(item.name) ||
        !item.theme || typeof item.theme !== "object") continue;
    const theme = { ...TERMINAL_THEMES.fineshellDark.theme } as StoredTerminalTheme["theme"];
    for (const key of [...ANSI_COLOR_KEYS, ...Object.values(GHOSTTY_COLOR_KEYS)]) {
      const value: unknown = item.theme[key];
      if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) theme[key] = value.toLowerCase();
    }
    result.set(item.name, { name: item.name, theme });
  }
  return [...result.values()];
}

export function isTerminalColorScheme(
  value: unknown,
  custom: readonly StoredTerminalTheme[] = [],
): value is TerminalColorScheme {
  return (
    value === "appearance" ||
    (typeof value === "string" &&
      (Object.prototype.hasOwnProperty.call(TERMINAL_THEMES, value) ||
        BASE24_TERMINAL_THEMES.has(value) ||
        custom.some(({ name }) => customTerminalThemeId(name) === value)))
  );
}

export function resolveTerminalTheme(
  scheme: TerminalColorScheme,
  appearance: ResolvedAppearance,
  custom: readonly StoredTerminalTheme[] = [],
): TerminalThemeDefinition {
  if (scheme.startsWith("ghostty:")) {
    const selected = custom.find(({ name }) => customTerminalThemeId(name) === scheme);
    if (selected) return { label: selected.name, swatch: selected.theme.background, theme: selected.theme };
  } else if (scheme.startsWith("base24:")) {
    const selected = BASE24_TERMINAL_THEMES.get(scheme);
    if (selected) return selected;
  } else if (scheme !== "appearance") {
    return TERMINAL_THEMES[scheme as keyof typeof TERMINAL_THEMES];
  }
  return appearance === "dark" ? TERMINAL_THEMES.fineshellDark : TERMINAL_THEMES.graphiteLight;
}
