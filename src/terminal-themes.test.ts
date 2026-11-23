import { expect, test } from "bun:test";
import { sanitizeAppSettings } from "./app-settings";
import { resolveTerminalTheme, TERMINAL_THEMES } from "./terminal-themes";

test("follows appearance by default and preserves an explicit palette", () => {
  const defaults = sanitizeAppSettings({});
  expect(resolveTerminalTheme(defaults.terminalColorScheme, "light"))
    .toBe(TERMINAL_THEMES.graphiteLight);
  expect(resolveTerminalTheme(defaults.terminalColorScheme, "dark"))
    .toBe(TERMINAL_THEMES.fineshellDark);
  for (const scheme of ["fineshellDark", "deepOcean"] as const) {
    const settings = sanitizeAppSettings({ terminalColorScheme: scheme });
    expect(resolveTerminalTheme(settings.terminalColorScheme, "light"))
      .toBe(TERMINAL_THEMES[scheme]);
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
      expect((luminance(background) + 0.05) / (luminance(hex) + 0.05), name)
        .toBeGreaterThanOrEqual(4.5);
    }
  }
});
