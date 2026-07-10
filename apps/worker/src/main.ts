import "reflect-metadata";

import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { WorkerModule } from "./worker.module";

export async function createWorkerApplication(): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: process.env.NODE_ENV === "test" ? false : ["error", "warn", "log"],
  });
  app.enableShutdownHooks();
  return app;
}

async function bootstrap(): Promise<void> {
  await createWorkerApplication();
}

if (require.main === module) {
  void bootstrap();
}
