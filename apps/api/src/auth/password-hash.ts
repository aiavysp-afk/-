import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const PARAMETERS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_CONCURRENT_DERIVATIONS = 4;
let activeDerivations = 0;

export class PasswordHashCapacityError extends Error {
  constructor() {
    super("密码校验繁忙，请稍后重试");
  }
}

export function isStaffPasswordValid(password: string) {
  return (
    password.length >= 12 &&
    password.length <= 128 &&
    Buffer.byteLength(password, "utf8") <= 512 &&
    !password.includes("\0")
  );
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (activeDerivations >= MAX_CONCURRENT_DERIVATIONS)
    throw new PasswordHashCapacityError();
  activeDerivations++;
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, PARAMETERS, (error, key) => {
      activeDerivations--;
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashStaffPassword(password: string) {
  if (!isStaffPasswordValid(password)) throw new Error("密码格式无效");
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt.v1.32768.8.1.${salt.toString("hex")}.${key.toString("hex")}`;
}

// Unknown accounts take the same scrypt cost as configured accounts. This value
// is a public dummy, never an account credential or an accepted login password.
export const DUMMY_STAFF_PASSWORD_HASH = `scrypt.v1.32768.8.1.${"00".repeat(16)}.${"00".repeat(32)}`;

export async function verifyStaffPassword(password: string, encoded: string) {
  const match =
    /^scrypt\.v1\.32768\.8\.1\.([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(encoded);
  const salt = Buffer.from(match?.[1] ?? "00".repeat(16), "hex");
  const expected = Buffer.from(match?.[2] ?? "00".repeat(32), "hex");
  const candidate = await derive(password, salt);
  return Boolean(match) && timingSafeEqual(candidate, expected);
}
