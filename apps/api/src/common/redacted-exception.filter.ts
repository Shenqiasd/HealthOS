import { Catch, HttpException, HttpStatus } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import {
  CORRELATION_ID_HEADER,
  resolveCorrelationId,
} from "@healthos/observability";
import type { FastifyReply, FastifyRequest } from "fastify";

function errorCode(status: number): string {
  const known: Record<number, string> = {
    [HttpStatus.BAD_REQUEST]: "BAD_REQUEST",
    [HttpStatus.UNAUTHORIZED]: "UNAUTHORIZED",
    [HttpStatus.FORBIDDEN]: "FORBIDDEN",
    [HttpStatus.NOT_FOUND]: "NOT_FOUND",
    [HttpStatus.CONFLICT]: "CONFLICT",
    [HttpStatus.TOO_MANY_REQUESTS]: "TOO_MANY_REQUESTS",
    [HttpStatus.SERVICE_UNAVAILABLE]: "SERVICE_UNAVAILABLE",
  };
  return known[status] ?? "INTERNAL_ERROR";
}

function publicMessage(exception: unknown, status: number): string {
  if (status >= 500) return "Internal Server Error";
  const fixed: Record<number, string> = {
    [HttpStatus.BAD_REQUEST]: "Bad Request",
    [HttpStatus.UNAUTHORIZED]: "Unauthorized",
    [HttpStatus.FORBIDDEN]: "Forbidden",
    [HttpStatus.NOT_FOUND]: "Not Found",
    [HttpStatus.CONFLICT]: "Conflict",
    [HttpStatus.TOO_MANY_REQUESTS]: "Too Many Requests",
    [HttpStatus.SERVICE_UNAVAILABLE]: "Service Unavailable",
  };
  if (fixed[status]) return fixed[status];
  if (!(exception instanceof HttpException)) return "Request failed";
  const response = exception.getResponse();
  if (typeof response === "string") return response;
  if (typeof response === "object" && response && "message" in response) {
    const message = response.message;
    if (typeof message === "string") return message;
    if (Array.isArray(message)) return "Request validation failed";
  }
  return exception.message;
}

@Catch()
export class RedactedExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const correlationId = resolveCorrelationId(
      request.headers[CORRELATION_ID_HEADER],
    );

    reply.status(status).send({
      error: {
        code: errorCode(status),
        message: publicMessage(exception, status),
        correlation_id: correlationId,
      },
    });
  }
}
