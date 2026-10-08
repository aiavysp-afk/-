import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

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
        path: request.url.split("?", 1)[0],
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
    if (!exception || typeof exception !== "object" || !("code" in exception))
      return undefined;
    const code = (exception as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z0-9_-]{1,48}$/.test(code)
      ? code
      : undefined;
  }
}
