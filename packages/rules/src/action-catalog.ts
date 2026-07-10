import type { ActionCode } from "./types";

export interface ActionDefinition {
  code: ActionCode;
  durationMinutes: number;
  difficulty: "light" | "standard";
  contraindicationTags: readonly string[];
  lighterVariant: ActionCode | null;
  swapFamily: "sleep" | "movement" | "drink";
  copyKey: string;
}

function freezeAction(definition: ActionDefinition): ActionDefinition {
  return Object.freeze({
    ...definition,
    contraindicationTags: Object.freeze([...definition.contraindicationTags]),
  });
}

export const ACTION_CATALOG: Readonly<Record<ActionCode, ActionDefinition>> = Object.freeze({
  SLEEP_WIND_DOWN: freezeAction({
    code: "SLEEP_WIND_DOWN",
    durationMinutes: 10,
    difficulty: "standard",
    contraindicationTags: [],
    lighterVariant: "SLEEP_WIND_DOWN_LIGHT",
    swapFamily: "sleep",
    copyKey: "action.sleep_wind_down",
  }),
  SLEEP_WIND_DOWN_LIGHT: freezeAction({
    code: "SLEEP_WIND_DOWN_LIGHT",
    durationMinutes: 5,
    difficulty: "light",
    contraindicationTags: [],
    lighterVariant: null,
    swapFamily: "sleep",
    copyKey: "action.sleep_wind_down_light",
  }),
  POST_MEAL_WALK: freezeAction({
    code: "POST_MEAL_WALK",
    durationMinutes: 12,
    difficulty: "standard",
    contraindicationTags: ["mobility_limited"],
    lighterVariant: null,
    swapFamily: "movement",
    copyKey: "action.post_meal_walk",
  }),
  SUGARY_DRINK_SWAP: freezeAction({
    code: "SUGARY_DRINK_SWAP",
    durationMinutes: 1,
    difficulty: "light",
    contraindicationTags: [],
    lighterVariant: null,
    swapFamily: "drink",
    copyKey: "action.sugary_drink_swap",
  }),
});

export function getAction(code: ActionCode): ActionDefinition {
  return ACTION_CATALOG[code];
}
