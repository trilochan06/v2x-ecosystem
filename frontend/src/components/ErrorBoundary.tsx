import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Named in the fallback so a viewer can say which part failed. */
  area?: string;
}

interface State {
  error: Error | null;
}

/**
 * Stops one thrown render from blanking the whole site.
 *
 * The simulation runs in the browser, so a bad tick surfaces as a React error
 * rather than a 500 someone can read in a server log. Without a boundary the
 * user gets a white page and no idea what happened -- during a live demo,
 * that is the worst possible failure mode. This keeps the rest of the page
 * usable, says what broke, and offers a reload.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept on the console so the stack is recoverable from a demo machine.
    console.error("Unhandled error in", this.props.area ?? "the application", error, info);
  }

  private reset = () => this.setState({ error: null });

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="error-boundary" role="alert">
        <h2>{this.props.area ?? "This view"} stopped responding</h2>
        <p>
          The simulation runs entirely in this browser tab, so nothing was lost on a server —
          reloading restarts it from a clean state.
        </p>
        <pre className="error-detail">{error.message}</pre>
        <div className="error-actions">
          <button type="button" onClick={this.reset}>
            Try this view again
          </button>
          <button type="button" onClick={() => window.location.reload()}>
            Reload the simulation
          </button>
        </div>
      </div>
    );
  }
}
