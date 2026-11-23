import type { ITheme } from "@xterm/xterm";
import type { ResolvedAppearance } from "./appearance";

export interface TerminalThemeDefinition {
  label: string;
  swatch: string;
  theme: ITheme & { background: string; foreground: string };
}

export const TERMINAL_THEMES = {
  fineshellDark: {
    label: "栈渡深色",
    swatch: "#191b20",
    theme: {
      background: "#191b20",
      foreground: "#d7dae0",
      cursor: "#23c343",
      cursorAccent: "#191b20",
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

export type TerminalColorScheme = "appearance" | keyof typeof TERMINAL_THEMES;

export function isTerminalColorScheme(value: unknown): value is TerminalColorScheme {
  return (
    value === "appearance" ||
    (typeof value === "string" &&
      Object.prototype.hasOwnProperty.call(TERMINAL_THEMES, value))
  );
}

export function resolveTerminalTheme(
  scheme: TerminalColorScheme,
  appearance: ResolvedAppearance,
): TerminalThemeDefinition {
  if (scheme !== "appearance") return TERMINAL_THEMES[scheme];
  return appearance === "dark" ? TERMINAL_THEMES.fineshellDark : TERMINAL_THEMES.graphiteLight;
}
