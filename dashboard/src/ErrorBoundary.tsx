import { Component, type ErrorInfo, type ReactNode } from "react";

import { clearStoredValue, looksLikeAutofillError, STORAGE_KEYS } from "./lib/safe";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("dashboard render failed", error, info.componentStack);
  }

  private resetSessionState() {
    clearStoredValue(STORAGE_KEYS.baseUrl);
    clearStoredValue(STORAGE_KEYS.token);
    clearStoredValue(STORAGE_KEYS.liveMode);
    clearStoredValue(STORAGE_KEYS.liveUpdates);
    clearStoredValue(STORAGE_KEYS.pollIntervalMs);
    clearStoredValue(STORAGE_KEYS.environment);
  }

  override render() {
    if (!this.state.error) {
      return this.props.children;
    }

    const likelyAutofill = looksLikeAutofillError(this.state.error);

    return (
      <main className="app-shell fallback-shell">
        <section className="surface fallback-panel">
          <div className="section-header">
            <div>
              <h2>Dashboard Error Boundary</h2>
              <p>{likelyAutofill ? "Autofill or extension interference was isolated." : "A render failure was caught before it could take down the whole console."}</p>
            </div>
          </div>
          <p className="global-error">{this.state.error.message}</p>
          <div className="button-row">
            <button
              type="button"
              onClick={() => {
                this.resetSessionState();
                window.location.reload();
              }}
            >
              Reset saved settings
            </button>
            <button className="ghost" type="button" onClick={() => this.setState({ error: null })}>
              Retry render
            </button>
          </div>
        </section>
      </main>
    );
  }
}
