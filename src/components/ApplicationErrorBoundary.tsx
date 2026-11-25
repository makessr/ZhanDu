import { Component, type ErrorInfo, type ReactNode } from "react";
import { recordDiagnostic } from "../diagnostics";
import { finishWorkspaceStartup } from "../workspace-startup";

interface ApplicationErrorBoundaryProps {
  children: ReactNode;
}

interface ApplicationErrorBoundaryState {
  error: Error | null;
}

class ApplicationErrorBoundary extends Component<
  ApplicationErrorBoundaryProps,
  ApplicationErrorBoundaryState
> {
  state: ApplicationErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (document.documentElement.classList.contains("main-window")) {
      void finishWorkspaceStartup();
    }
    recordDiagnostic("error", "frontend.render", "界面渲染失败", {
      componentStack: info.componentStack,
      error: error.message,
    });
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="application-error" role="alert">
        <div className="application-error-content">
          <h1>界面加载失败</h1>
          <p>{this.state.error.message || "发生未知错误"}</p>
          <button type="button" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      </main>
    );
  }
}

export default ApplicationErrorBoundary;
