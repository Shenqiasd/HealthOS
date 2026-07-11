import "reflect-metadata";

import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import {
  CORRELATION_ID_HEADER,
  resolveCorrelationId,
} from "@healthos/observability";

import { AppModule } from "./app.module";
import { RedactedExceptionFilter } from "./common/redacted-exception.filter";

export async function createApp(): Promise<NestFastifyApplication> {
  const enableLogger = process.env.NODE_ENV !== "test";
  const adapter = new FastifyAdapter({
    logger: enableLogger
      ? {
          level: process.env.LOG_LEVEL ?? "info",
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.body",
              "res.body",
            ],
            censor: "[REDACTED]",
          },
        }
      : false,
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
    { logger: enableLogger ? ["error", "warn", "log"] : false },
  );

  const server = app.getHttpAdapter().getInstance();
  server.addHook("onRequest", async (request, reply) => {
    const correlationId = resolveCorrelationId(
      request.headers[CORRELATION_ID_HEADER],
    );
    request.headers[CORRELATION_ID_HEADER] = correlationId;
    reply.header(CORRELATION_ID_HEADER, correlationId);
  });

  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );
  app.useGlobalFilters(new RedactedExceptionFilter());
  app.enableShutdownHooks();
  await app.init();
  await server.ready();
  return app;
}

async function bootstrap(): Promise<void> {
  const app = await createApp();
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  await app.listen({ host: "0.0.0.0", port });
}

if (require.main === module) {
  void bootstrap();
}
