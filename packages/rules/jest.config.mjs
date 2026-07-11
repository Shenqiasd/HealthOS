export default {
  displayName: "rules",
  rootDir: ".",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.spec.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
  collectCoverageFrom: [
    "src/action-catalog.ts",
    "src/input-validator.ts",
    "src/risk-engine.ts",
    "src/safety-policy.ts",
    "src/rule-bundle.ts",
  ],
  coverageThreshold: {
    global: { branches: 100, functions: 100, lines: 100, statements: 100 },
  },
};
