/**
 * src/adapter/registry.ts — adapter registrations + rollback writer.
 *
 * Each entry names one persisted adapter mode (its RouterState key). rollBack
 * writes each mode to "off" and returns the switched names, so /adapter
 * rollback can say what it did instead of blind-writes.
 */
import type { RouterState } from "../router/config";
import { writeState } from "../router/config";

/** Persisted adapter mode (its RouterState key). */
export interface AdapterEntry {
  /** Adapter name. */
  name: string;
  /** Persisted mode key in RouterState; rollBack writes its value to "off". */
  modeKey: keyof RouterState;
}

/** Ordered registry of adapters the router can target on rollback. */
export const adapterRegistry: AdapterEntry[] = [];

/** Register an adapter entry. Order defines rollBack order. */
export function registerAdapter(entry: AdapterEntry): void {
  if (entry.name) {
    adapterRegistry.push(entry);
  }
}

/** Write a state patch that turns each registered mode off; returns switched names. */
export function rollBackAdapters(): string[] {
  const names: string[] = [];
  for (const entry of adapterRegistry) {
    names.push(entry.name);
    writeState({ [entry.modeKey]: "off" } as Partial<RouterState>); // every modeKey is a RouterState key
  }
  return names;
}
