import { openDatabase } from "../db/database.js";
import { OutboundStore } from "../db/store.js";

export function withStore(action: (store: OutboundStore) => void): void {
  const db = openDatabase();
  try {
    action(new OutboundStore(db));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

export function parseCompanyIds(args: string[]): number[] {
  if (args.length === 0) throw new Error("Provide at least one company ID");
  return args.map((value) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid company ID: ${value}`);
    return id;
  });
}
