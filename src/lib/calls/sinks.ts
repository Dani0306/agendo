import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Db } from "@/lib/db/client";
import { unwrap } from "@/lib/db/unwrap";
import type { CallSink } from "./record-call";

/** For scripts and evals: one JSON line per call. */
export function jsonlSink(path: string): CallSink {
  return async (row) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(row)}\n`, "utf8");
  };
}

/** For the app: one row in agendo.model_calls. */
export function dbSink(client: Db): CallSink {
  return async (row) => {
    unwrap(await client.from("model_calls").insert(row).select("id"));
  };
}
