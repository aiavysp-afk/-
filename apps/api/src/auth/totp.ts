import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function encodeBase32(bytes: Buffer) {
  let bits = 0,
    value = 0,
    output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
export function decodeSecret(value: string) {
  if (!/^[A-Z2-7]{32}$/.test(value))
    throw Error("Invalid TOTP secret encoding");
  let bits = 0,
    accumulator = 0;
  const bytes: number[] = [];
  for (const char of value) {
    accumulator = (accumulator << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 255);
    }
  }
  return Buffer.from(bytes);
}
export const createTotpSecret = () => encodeBase32(randomBytes(20));
export function hotp(secret: Buffer, counter: bigint, digits = 6) {
  if (counter < 0n || counter > 0xffffffffffffffffn || ![6, 8].includes(digits))
    throw Error("Invalid TOTP counter");
  const input = Buffer.alloc(8);
  input.writeBigUInt64BE(counter);
  const mac = createHmac("sha1", secret).update(input).digest();
  const offset = mac[mac.length - 1]! & 15;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits)
    .toString()
    .padStart(digits, "0");
}
export function matchTotp(
  secret: string,
  code: string,
  now: Date,
  lastStep: bigint | null,
) {
  if (
    !/^\d{6}$/.test(code) ||
    !Number.isFinite(now.getTime()) ||
    now.getTime() < 0
  )
    return null;
  const key = decodeSecret(secret),
    current = BigInt(Math.floor(now.getTime() / 30_000));
  let matched: bigint | null = null;
  for (const drift of [-1n, 0n, 1n]) {
    const step = current + drift;
    if (step < 0n) continue;
    const same = timingSafeEqual(
      Buffer.from(hotp(key, step)),
      Buffer.from(code),
    );
    if (same && (lastStep === null || step > lastStep)) matched = step;
  }
  return matched;
}
