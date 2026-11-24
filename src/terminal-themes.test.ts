import { expect, test } from "bun:test";
import { sanitizeAppSettings } from "./app-settings";
import {
  ANSI_COLOR_KEYS,
  BASE24_TERMINAL_THEMES,
  customTerminalThemeId,
  parseGhosttyTheme,
  resolveTerminalTheme,
  TERMINAL_THEMES,
} from "./terminal-themes";

test("follows appearance by default and preserves an explicit palette", () => {
  const defaults = sanitizeAppSettings({});
  expect(resolveTerminalTheme(defaults.terminalColorScheme, "light")).toBe(
    TERMINAL_THEMES.graphiteLight,
  );
  expect(resolveTerminalTheme(defaults.terminalColorScheme, "dark")).toBe(
    TERMINAL_THEMES.fineshellDark,
  );
  for (const scheme of ["fineshellDark", "deepOcean"] as const) {
    const settings = sanitizeAppSettings({ terminalColorScheme: scheme });
    expect(resolveTerminalTheme(settings.terminalColorScheme, "light")).toBe(
      TERMINAL_THEMES[scheme],
    );
  }
});

function luminance(hex: string) {
  const channels = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

test("light theme keeps bright ANSI foregrounds readable on its background", () => {
  const { background, ...colors } = TERMINAL_THEMES.graphiteLight.theme;
  for (const [name, hex] of Object.entries(colors)) {
    if (name === "foreground" || name.startsWith("bright")) {
      expect((luminance(background) + 0.05) / (luminance(hex) + 0.05), name).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  }
});

test("imports Ghostty colors without applying unrelated directives", () => {
  const imported = parseGhosttyTheme(
    "星夜.conf",
    [
      "# sample theme",
      "background = #102030",
      "foreground = EEEEEE",
      "palette = 4 = #2299FF",
      "palette = 15=#FFFFFF",
      "selection-foreground = #000000",
      "config-file = /other/config",
      "cursor-color = url(evil)",
    ].join("\r\n"),
  );
  expect(imported.name).toBe("星夜");
  expect(imported.theme).toMatchObject({
    background: "#102030",
    foreground: "#eeeeee",
    blue: "#2299ff",
    brightWhite: "#ffffff",
    cursor: "#eeeeee",
    selectionForeground: "#000000",
  });
  expect(imported.theme).not.toHaveProperty("config-file");
  expect(() => parseGhosttyTheme("bad", "command = x\nbackground = url(x)")).toThrow();

  const id = customTerminalThemeId(imported.name);
  const stored = sanitizeAppSettings(
    JSON.parse(
      JSON.stringify({
        terminalColorScheme: id,
        terminalCustomThemes: [imported],
      }),
    ),
  );
  expect(
    resolveTerminalTheme(stored.terminalColorScheme, "light", stored.terminalCustomThemes).theme,
  ).toEqual(imported.theme);
  expect(sanitizeAppSettings({ terminalColorScheme: id }).terminalColorScheme).toBe("appearance");
});

test("bundled palettes contain all sixteen ANSI colors", () => {
  expect(BASE24_TERMINAL_THEMES.size).toBe(253);
  for (const { theme } of BASE24_TERMINAL_THEMES.values()) {
    for (const key of ANSI_COLOR_KEYS) {
      expect(theme[key]).toMatch(/^#[\da-f]{6}$/i);
    }
  }
  expect(sanitizeAppSettings({ terminalColorScheme: "base24:3024-day" }).terminalColorScheme).toBe(
    "base24:3024-day",
  );
});
