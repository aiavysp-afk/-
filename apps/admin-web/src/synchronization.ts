import { useEffect, useRef } from "react";

export function createLatestRequest() {
  let version = 0;
  return {
    begin() {
      const requestedVersion = ++version;
      return () => requestedVersion === version;
    },
    invalidate() {
      version++;
    },
  };
}

export function useBackgroundRefresh(refresh: () => void, enabled = true) {
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") latestRefresh.current();
    };
    const interval = window.setInterval(refreshWhenVisible, 15_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [enabled]);
}
