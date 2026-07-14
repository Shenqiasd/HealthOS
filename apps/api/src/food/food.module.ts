import path from "node:path";

import { Module } from "@nestjs/common";

import { DatabaseService } from "../database/prisma.service";
import { IdentityModule } from "../identity/identity.module";
import { FoodController } from "./food.controller";
import {
  FailClosedFoodObjectStore,
  FoodObjectStore,
  SyntheticFixtureFoodObjectStore,
} from "./food-object-store";
import { FoodService } from "./food.service";

function syntheticFoodEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.HEALTHOS_FOOD_MODE === "synthetic";
}

@Module({
  imports: [IdentityModule],
  controllers: [FoodController],
  providers: [
    {
      provide: FoodObjectStore,
      useFactory: () => syntheticFoodEnabled()
        ? new SyntheticFixtureFoodObjectStore(
          process.env.HEALTHOS_FOOD_FIXTURE_DIR ?? path.resolve(process.cwd(), "../../packages/test-fixtures/food"),
        )
        : new FailClosedFoodObjectStore(),
    },
    {
      provide: FoodService,
      inject: [DatabaseService, FoodObjectStore],
      useFactory: (database: DatabaseService, objectStore: FoodObjectStore) =>
        new FoodService(database, objectStore, syntheticFoodEnabled()),
    },
  ],
  exports: [FoodService],
})
export class FoodModule {}
