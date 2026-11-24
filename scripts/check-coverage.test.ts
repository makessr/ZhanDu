import { describe, expect, test } from "bun:test";
import { parseCoverageSummary } from "./check-coverage";

const report = `
 src\\App.tsx        |   0.00 |  4.65 | 71-828
 All files          |  69.00 | 74.16 |
`;

describe("coverage summary parsing", () => {
  test("extracts the aggregate functions and lines percentages", () => {
    expect(parseCoverageSummary(report)).toEqual({ functions: 69, lines: 74.16 });
  });

  test("returns null when the aggregate row is missing", () => {
    expect(parseCoverageSummary("527 pass\n0 fail")).toBeNull();
  });

  test("ignores per-file rows", () => {
    expect(parseCoverageSummary(" src\\App.tsx | 0.00 | 4.65 | 71-828")).toBeNull();
  });
});
