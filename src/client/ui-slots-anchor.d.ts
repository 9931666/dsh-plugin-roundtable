/**
 * Type-anchor shim for `@deepseek-ai/dsh-client-ui-slots` (+ the `ctx.effect`
 * overloads a consumer build drops).
 *
 * ## Why this file must stay a GLOBAL SCRIPT（关键约束，勿加 import/export）
 *
 * This file declares the ambient module `@deepseek-ai/dsh-client-ui-slots`.
 * Under TypeScript's rules a `declare module '...'` is an **ambient module
 * declaration** only while its file has no top-level import/export; adding one
 * turns it into a **module augmentation**, which must resolve to a real module
 * and fails with TS2664.
 *
 * That distinction matters here: `src/client/locales.ts` augments this same
 * module name for `LocaleNamespaceMap`. Its augmentation only resolves because
 * THIS file supplies the ambient module. Measured: adding a single
 * `import type` line here breaks both this file and `locales.ts` with
 * `TS2664: module '@deepseek-ai/dsh-client-ui-slots' cannot be found`.
 *
 * So: never add a top-level import/export to this file, and never delete it —
 * `@deepseek-ai/dsh-client-ui-slots` is genuinely unpublished (absent from
 * node_modules, from the npx cache's `.pnpm`, and from package-lock; it exists
 * only as a devDependency type anchor of `dsh-client-ui-renderer` and as a seed
 * entry in the web shell bundle).
 *
 * ## What changed in v0.2.21
 *
 * v0.2.2 declared `ctx.slots` as a hand-written 2-member `RoundTableSlotsService`.
 * Measured against 0.1.5-rc.2 that declaration **won** the interface merge and
 * shadowed the host's real face (`dsh-client-ui-renderer/lib/types/client/index.d.ts`:
 * `slots: SlotRegistry`), hiding `entries`/`getVersion`/`subscribe`/`spec`/
 * `snapshot`/`onEntryError` from this plugin.
 *
 * v0.2.21 mirrors the host's real `SlotRegistry` face member-for-member instead,
 * so `ctx.slots` is usable exactly like the documented service. The mirror
 * cannot be expressed as `import type { SlotRegistry }` for the reason above.
 *
 * ## Known host-side limitation
 *
 * `SlotRegistry['register']` resolves to `any` for **every** consumer, because
 * the host declares it as `SlotCore['register']` and `SlotCore` lives in the
 * unpublished ui-slots package. The precise signature kept below is therefore
 * measured from the host runtime rather than imported:
 * `dsh-client-ui-renderer/lib/client.js` → `_register(options, component)`,
 * where `register` is assigned to the core's two-argument implementation and
 * returns a disposer (`() => void`). It matches the official example shipped in
 * `dsh-cordis-client-runner/lib/client.js`.
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** Registry of locale namespaces -> dictionary key unions, merged by every client package. */
  interface LocaleNamespaceMap {}
  /** Registry of declared slot keys, merged by every client package. */
  interface SlotMap {}
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Renderer-owned UI composition registry — mirror of the host's real `SlotRegistry`. */
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

/**
 * One synchronous effect installed while an injected slot declaration is live.
 * Matches the host's `SlotInjectionEffect`: a disposer, or an iterable of them.
 */
type RoundTableSlotInjectionEffect = (() => void) | Iterable<() => void>

/**
 * Registration descriptor consumed by `register` (host `SlotSpec` subset this
 * plugin uses; `name`/`id` required, `order`/`label`/`locale`/`inject`/`store`
 * carried through to the SlotCore entry).
 */
interface RoundTableSlotEntry {
  name: string
  id: string
  order?: number
  label?: string | (() => string)
  locale?: string
  inject?: () => unknown
  children?: Record<string, unknown>
  store?: unknown
  registrant?: string
}

/**
 * Mirror of the host `SlotRegistry` service face (0.1.5-rc.2), restricted to
 * the members a plugin may call. Registration APIs are the documented ones;
 * the `install*`/`provide*`/`bind*`/`renderSlot` boot APIs belong to the shell
 * and are intentionally omitted until this plugin needs them.
 */
interface RoundTableSlotsService {
  /**
   * The single registration API (descriptor + rendered component).
   * Measured from the host runtime; upstream type degrades to `any`.
   */
  register(entry: RoundTableSlotEntry, component: unknown): () => void
  /**
   * Install an effect for each declaration lifetime of a slot. The callback
   * runs synchronously when the declaration already exists, otherwise inside
   * the declaring `register()` call.
   */
  inject(key: keyof SlotMap & string, callback: () => RoundTableSlotInjectionEffect): () => void
  /** Snapshot entries for a key (render-erased view). */
  entries(key: keyof SlotMap & string): readonly unknown[]
  /** Shadowing winners per cell for a key. */
  entriesOfSlot(key: keyof SlotMap & string): readonly unknown[]
  /** Export the current JSON-safe Slot declaration tree for read-only inspection. */
  snapshot(root?: string): unknown[]
  /** Observe entry boundary crashes; the returned unsubscribe is caller-owned. */
  onEntryError(fn: (key: string, entry: unknown, error: unknown, info: { abdicated: boolean }) => void): () => void
  /** Look up a declared spec (register-declared or the built-in 'root'). */
  spec(key: keyof SlotMap & string): unknown
  /** Subscribe to a key's registration changes (microtask-batched). */
  subscribe(key: keyof SlotMap & string, fn: () => void): () => void
  /** Version counter for uSES pairing. */
  getVersion(key: keyof SlotMap & string): number
}
