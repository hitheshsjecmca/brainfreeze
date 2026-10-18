import { Component } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

/**
 * Catches an error thrown while rendering a page, so one failing component shows a message instead of unmounting
 * the whole application (a blank screen). `resetKey` (the URL) clears the error after navigating elsewhere.
 * Data is never changed here: the database is the authority and reloading shows its current state.
 */
export default class ErrorBoundary extends Component {
  state = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error) {
    return { error };
  }

  static getDerivedStateFromProps(props, state) {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error, info) {
    console.error('Page failed to render:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="state-box state-error" role="alert" style={{ margin: '2rem auto', maxWidth: 640 }}>
        <AlertTriangle size={28} aria-hidden="true" />
        <h2>This page could not be displayed</h2>
        <p className="muted">{String(error?.message || error)}</p>
        <p className="muted small">Nothing was changed by this error. Reloading shows the current saved state.</p>
        <div className="row gap wrap">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}><RefreshCw size={16} /> Reload page</button>
          <a className="btn btn-ghost" href="/">Home</a>
        </div>
      </div>
    );
  }
}
