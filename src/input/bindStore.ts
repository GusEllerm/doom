// input/bindStore.ts — M11-03 stub (bindings table as DATA for M11-07).
// Placeholder; full implementation per docs/design/M11-plan.md §M11-03.

import { DEFAULT_BINDINGS, type KeyBinding } from './mapping';

export function bindStoreDefaults(): readonly KeyBinding[] {
  return DEFAULT_BINDINGS;
}
