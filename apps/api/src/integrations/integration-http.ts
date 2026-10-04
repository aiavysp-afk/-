// Never include provider URLs, body, headers or underlying exception text in diagnostics.
export async function readIntegrationJson(
  response: Response,
): Promise<unknown> {
  if (
    !response.ok ||
    !response.body ||
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? "",
    )
  ) {
    await response.body?.cancel().catch(() => {});
    throw Error("Integration response rejected");
  }
  const maxBytes = 65_536;
  const advertised = response.headers.get("content-length");
  if (
    advertised &&
    (!/^\d+$/.test(advertised) || Number(advertised) > maxBytes)
  ) {
    await response.body.cancel();
    throw Error("Integration response too large");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw Error("Integration response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
