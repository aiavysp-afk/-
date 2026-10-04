import { createHash, createHmac } from "node:crypto";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const encodeRpc = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

// All RPC query fields and all common headers are signed; body is deliberately empty.
export function signAliyunRpc(input: {
  host: string;
  action: string;
  version: string;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
  date: string;
  nonce: string;
  params: Record<string, string>;
}) {
  const query = Object.keys(input.params)
    .sort()
    .map((k) => `${encodeRpc(k)}=${encodeRpc(input.params[k]!)}`)
    .join("&");
  const headers: Record<string, string> = {
    host: input.host,
    "x-acs-action": input.action,
    "x-acs-version": input.version,
    "x-acs-date": input.date,
    "x-acs-signature-nonce": input.nonce,
    "x-acs-content-sha256": sha256(""),
  };
  if (input.securityToken)
    headers["x-acs-security-token"] = input.securityToken;
  if (
    Object.values(headers).some((v) => /[\r\n]/.test(v) || v !== v.trim()) ||
    /[\r\n,\s]/.test(input.accessKeyId)
  )
    throw Error("Invalid signing headers");
  const names = Object.keys(headers).sort();
  const signed = names.join(";");
  const canonical = [
    "POST",
    "/",
    query,
    names.map((k) => `${k}:${headers[k]}\n`).join(""),
    signed,
    sha256(""),
  ].join("\n");
  const signature = createHmac("sha256", input.accessKeySecret)
    .update(`ACS3-HMAC-SHA256\n${sha256(canonical)}`)
    .digest("hex");
  headers.authorization = `ACS3-HMAC-SHA256 Credential=${input.accessKeyId},SignedHeaders=${signed},Signature=${signature}`;
  return { query, headers };
}
