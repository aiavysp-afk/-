import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { safeTelemetryPath } from "./safe-request-log.js";

const SafeBusinessErrorCodes = new Set([
  "ACCOUNT_LINK_CONFLICT",
  "CONFIGURATION_NOT_READY",
  "LOGIN_BUSY",
  "SMS_DAILY_REQUEST_LIMIT",
  "SMS_BUDGET_UNAVAILABLE",
]);
const safeCode = (value: unknown) =>
  typeof value === "string" &&
  (SafeBusinessErrorCodes.has(value) || /^P[0-9]{4}$/.test(value))
    ? value
    : undefined;

@Catch()
export class HttpExceptionTelemetryFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const errorCode = this.safeErrorCode(exception);

    request.log.error(
      {
        event: "http_exception",
        requestId: request.id,
        method: request.method,
        path: safeTelemetryPath(request.url),
        statusCode,
        errorName:
          exception instanceof Error ? exception.name : "UnknownException",
        ...(errorCode ? { errorCode } : {}),
      },
      "request failed",
    );

    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      reply
        .status(statusCode)
        .send(
          typeof response === "string"
            ? { statusCode, message: response }
            : response,
        );
      return;
    }
    reply.status(statusCode).send({
      statusCode,
      message: "服务暂时不可用，请稍后重试",
    });
  }

  private safeErrorCode(exception: unknown) {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (response && typeof response === "object" && "code" in response) {
        const code = safeCode(response.code);
        if (code) return code;
      }
    }
    return exception && typeof exception === "object" && "code" in exception
      ? safeCode(exception.code)
      : undefined;
  }
}
