/** Capability URLs are secrets, including malformed/expired invitations. */
export function safeTelemetryPath(url: unknown): string {
  if (typeof url !== "string") return "[unknown]";
  const path = url.split(/[?#]/, 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return "[invalid-path]";
  }
  const capability = decoded.match(/^(.*?\/friend-payments)(?:\/|$)/i);
  if (capability) {
    // Do not log even an invalid token or a caller-controlled suffix.
    const operation = decoded.slice(capability[0].length).split("/")[1];
    const suffix = operation === "payment-intent" || operation === "reconcile"
      ? `/${operation}`
      : "";
    return `${capability[1]}/[redacted]${suffix}`;
  }
  return path;
}

/** Omit headers, body, IP and query strings from automatic request logging. */
export function safeRequestLog(request: { method?: unknown; url?: unknown }) {
  return {
    method: typeof request.method === "string" ? request.method : "[unknown]",
    url: safeTelemetryPath(request.url),
  };
}
