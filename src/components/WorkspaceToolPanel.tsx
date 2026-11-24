import type { ComponentProps, ReactNode } from "react";
import { Drawer, Tabs } from "@arco-design/web-react";

const TOOLS = [
  ["files", "文件"],
  ["transfers", "传输"],
  ["tunnels", "隧道"],
  ["processes", "进程"],
  ["network", "网络"],
  ["commands", "命令"],
] as const;

export type WorkspaceTool = (typeof TOOLS)[number][0];

export function WorkspaceToolPanel({
  activeTool,
  onSelect,
  children,
}: {
  activeTool: WorkspaceTool;
  onSelect: (tool: WorkspaceTool) => void;
  children: ReactNode;
}) {
  return (
    <section aria-label="会话工具" className="panel workspace-tools">
      <Tabs
        activeTab={activeTool}
        className="workspace-tool-tabs"
        onChange={(key) => {
          const tool = TOOLS.find(([id]) => id === key);
          if (tool) onSelect(tool[0]);
        }}
        size="small"
      >
        {TOOLS.map(([id, label]) => (
          <Tabs.TabPane key={id} title={label} />
        ))}
      </Tabs>
      <div
        aria-label={TOOLS.find(([id]) => id === activeTool)?.[1]}
        className="workspace-tool-body"
        role="tabpanel"
      >
        {children}
      </div>
    </section>
  );
}

export function WorkspaceToolSurface({
  embedded,
  children,
  ...drawer
}: ComponentProps<typeof Drawer> & { embedded?: boolean }) {
  if (!embedded) return <Drawer {...drawer}>{children}</Drawer>;
  if (!drawer.visible) return null;
  return <div className={`workspace-tool-surface ${drawer.className ?? ""}`}>{children}</div>;
}
