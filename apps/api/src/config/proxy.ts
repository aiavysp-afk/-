// Production's API socket is loopback-only behind the directly connected Nginx.
// Trusting every forwarded hop lets a caller forge the left-most SMS rate key.
export const REVERSE_PROXY_TRUST = ["127.0.0.1", "::1"];
