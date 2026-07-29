import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider, Toaster, Text } from "@glaze/core/components";
import { initLogging } from "@glaze/core/utils";
import { DocumentsView } from "./documents-view";
import "../styles.css";

initLogging();

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[documents] Render crash:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
          <Text variant="strong">Something went wrong loading the Document Browser.</Text>
          <Text variant="small" color="secondary">
            {this.state.error.message}
          </Text>
          <Text variant="small" color="tertiary">
            {this.state.error.stack?.slice(0, 500)}
          </Text>
        </div>
      );
    }
    return this.props.children;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <TooltipProvider>
          <DocumentsView />
        </TooltipProvider>
      </ErrorBoundary>
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);

if (import.meta.hot) {
  import.meta.hot.accept();
}
