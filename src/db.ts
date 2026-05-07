import postgres from "postgres";
import { envString, type AppEnv } from "./env.js";

export type Sql = ReturnType<typeof postgres>;

let sharedSql: Sql | undefined;

export function database(env: AppEnv): Sql {
  const url = envString(env, "DATABASE_URL");
  if (!url) {
    throw new Error("DATABASE_URL secret is required");
  }
  if (!sharedSql) {
    sharedSql = postgres(url, {
      connect_timeout: 10,
      idle_timeout: 20,
      max: 16,
      prepare: false,
      ssl: "require",
    });
  }
  return sharedSql;
}
