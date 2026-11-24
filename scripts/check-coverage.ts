const DEFAULT_MIN_FUNCTIONS = 68;
const DEFAULT_MIN_LINES = 73;

export interface CoverageSummary {
  functions: number;
  lines: number;
}

export function parseCoverageSummary(report: string): CoverageSummary | null {
  const match = report.match(/^\s*All files\s+\|\s*([\d.]+)\s*\|\s*([\d.]+)/m);
  if (!match) return null;
  return { functions: Number(match[1]), lines: Number(match[2]) };
}

if (import.meta.main) {
  const path = process.argv[2];
  let report: string;
  if (path) {
    report = await Bun.file(path).text();
  } else {
    const run = Bun.spawnSync([process.execPath, "test", "--coverage"]);
    report = run.stdout.toString() + run.stderr.toString();
    process.stdout.write(report);
    if (run.exitCode !== 0) {
      console.error("单元测试未通过，先修复失败用例再检查覆盖率。");
      process.exit(run.exitCode ?? 1);
    }
  }
  const summary = parseCoverageSummary(report);
  if (!summary) {
    console.error("未能从测试输出中解析覆盖率汇总行（需要 bun test --coverage 的文本报告）");
    process.exit(1);
  }
  const minFunctions = Number(process.env.COVERAGE_MIN_FUNCTIONS ?? DEFAULT_MIN_FUNCTIONS);
  const minLines = Number(process.env.COVERAGE_MIN_LINES ?? DEFAULT_MIN_LINES);
  console.log(
    `覆盖率：函数 ${summary.functions.toFixed(2)}%（门槛 ${minFunctions}%），行 ${summary.lines.toFixed(2)}%（门槛 ${minLines}%）`,
  );
  if (summary.functions < minFunctions || summary.lines < minLines) {
    console.error("覆盖率低于门槛，请补充测试或按评审结论调整门槛并评审原因。");
    process.exit(1);
  }
}
