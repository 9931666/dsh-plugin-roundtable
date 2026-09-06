/**
 * Type-anchor shim for `@deepseek-ai/dsh-client-ui-slots` (+ the missing
 * `ctx.slots` merge).
 *
 * In the 0.1.2-rc.1 release the ui-slots runtime package was absorbed into
 * `dsh-client-ui-renderer`, but every client package (locale, ui-conversation,
 * ui-settings, ui-layout, …) still MERGES its slot/locale declarations into
 * this module name via `declare module '@deepseek-ai/dsh-client-ui-slots'`.
 * The module is therefore a pure type anchor: nothing imports it at runtime.
 *
 * These bare interfaces are what the merging packages augment; without this
 * anchor file TypeScript cannot resolve the module and every merge silently
 * fails (TS2664 / TS2307). The `ctx.slots` service declaration below patches
 * the same release gap for static (non-dynamic) client plugins; the runtime
 * service itself is provided by ui-renderer.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** Registry of locale namespaces -> dictionary key unions, merged by every client package. */
  interface LocaleNamespaceMap {}
  /** Registry of declared slot keys, merged by every client package. */
  interface SlotMap {}
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Slot registry (ui-renderer). Local declaration for 0.1.2-rc.1 static plugins. */
    slots: RoundTableSlotsService
    /**
     * Fiber effect registration. cordis ships this merge from its internal
     * `fiber.d.ts`, but loading any client package augmentation (locale,
     * ui-conversation, …) drops it in a consumer build; redeclare the
     * callable overloads here so `ctx.effect(...)` keeps typechecking.
     */
    effect(execute: () => () => void, label?: string): unknown
    effect(execute: () => unknown, label?: string): unknown
  }
}

/** Minimal slot-registry face used by this plugin's two registrations. */
interface RoundTableSlotsService {
  /** Install an effect for each declaration lifetime of a slot. */
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
  /** The single registration API (descriptor + rendered component). */
  register(entry: RoundTableSlotEntry, component: unknown): () => void
}

/** Structural slot registration options consumed by `RoundTableSlotsService.register`. */
interface RoundTableSlotEntry {
  name: string
  id: string
  order?: number
  label?: () => string
  locale?: string
  inject?: () => unknown
  children?: Record<string, unknown>
  store?: unknown
}
