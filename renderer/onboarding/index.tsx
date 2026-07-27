import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider, Toaster } from "@glaze/core/components";
import { initLogging } from "@glaze/core/utils";
import { OnboardingView } from "./onboarding-view";
import "../styles.css";

initLogging();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <OnboardingView />
      </TooltipProvider>
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);

if (import.meta.hot) {
  import.meta.hot.accept();
}
