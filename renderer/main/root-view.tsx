import { Outlet } from "@tanstack/react-router";
import * as React from "react";
import { useTheme } from "@glaze/core/hooks";

export function RootView() {
  useTheme();

  // Cleanup IPC connection on unmount
  React.useEffect(() => {
    return () => {
      window.glazeAPI?.glaze?.ipc?.disconnect();
    };
  }, []);

  return (
    <div className="h-full w-full">
      <Outlet />
    </div>
  );
}
