export * from "./generated/api";
// Orval gives some request parameter schemas and types the same name
// (for example GetGameParams). Keep the schemas as named exports and group
// generated TypeScript types under a namespace to avoid export collisions.
export * as types from "./generated/types";
