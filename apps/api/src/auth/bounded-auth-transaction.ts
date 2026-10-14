import { ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../database/prisma.service.js";

type TransactionHost = Pick<PrismaService, "$transaction">;
type Operation<T> = (tx: Prisma.TransactionClient) => Promise<T>;
const OPTIONS = { timeout: 15_000, maxWait: 5_000 };

// A client/ORM deadline alone can leave PostgreSQL waiting on an advisory lock
// or idle inside an open transaction. These server budgets are local to each
// authentication/phone-binding transaction, never global connection settings.
export async function withBoundedAuthTransaction<T>(
  prisma: TransactionHost,
  operation: Operation<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '10000ms'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '12000ms'`;
      await tx.$executeRaw`SET LOCAL idle_in_transaction_session_timeout = '12000ms'`;
      return operation(tx);
    }, OPTIONS);
  } catch (error) {
    const databaseCode =
      error &&
      typeof error === "object" &&
      "meta" in error &&
      error.meta &&
      typeof error.meta === "object" &&
      "code" in error.meta
        ? error.meta.code
        : undefined;
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    const serverTimeout = ["55P03", "57014", "25P03"].includes(
      typeof databaseCode === "string"
        ? databaseCode
        : typeof code === "string"
          ? code
          : "",
    );
    const clientTimeout =
      error instanceof Prisma.PrismaClientKnownRequestError &&
      ["P2028", "P1017"].includes(error.code);
    // No automatic retry can consume a WeChat code twice or dispatch SMS twice.
    if (serverTimeout || clientTimeout)
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: "LOGIN_BUSY",
        message: "登录请求较多，请稍后重新点击登录",
      });
    throw error;
  }
}
