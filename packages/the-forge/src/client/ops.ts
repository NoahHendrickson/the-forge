import type { StructuralDraft } from './drafts'
import type { StructuralOp } from './request'

/** The text op's `before` is pure locate-context — the element heading already targets the
 * edit — so it caps; `after` is the ask AND the verifier's textContent oracle, so it must
 * travel exact on both the wire and the markdown (a truncated ask is an unappliable edit). */
export const TEXT_BEFORE_CAP = 200

/** THE StructuralDraft → StructuralOp projection. One home on purpose: this mapping used to be
 * hand-inlined in request.ts (structuralOpsFor), changelist.ts (summarizeStructuralDraft's fake
 * op), and drafts.ts (commitStructural's match guard) — three copies that had already diverged
 * on the `before` cap (2026-07-23 review of PR #44). Type-only imports both ways keep this a
 * leaf module with zero runtime dependencies, so every layer can value-import it cycle-free. */
export function draftToOps(s: StructuralDraft): StructuralOp[] {
  if (s.kind === 'delete') return [{ kind: 'delete' }]
  return [{ kind: 'text', before: s.original.slice(0, TEXT_BEFORE_CAP), after: s.value }]
}

/** Structural-op identity for the duplicate window: same kinds in order, and text ops key on
 * `after` (a re-edit to DIFFERENT text is a genuinely new request — same rule as css deltas).
 * `before` is deliberately ignored: it's locate-context, not the ask. Every other kind compares
 * by full payload (JSON) — fail CLOSED: 'same kind ⇒ identical' would silently swallow a
 * payload-carrying future kind's re-send (P3 move to a different toIndex) as a duplicate, and
 * no exhaustiveness check would flag it (2026-07-23 review of PR #44). Delete has no payload,
 * so the JSON compare degenerates to the old kind-equality for it. */
export function opsIdentical(a: StructuralOp[] | undefined, b: StructuralOp[] | undefined): boolean {
  const aLen = a?.length ?? 0
  const bLen = b?.length ?? 0
  if (aLen !== bLen) return false
  if (!a || !b) return true
  return a.every((op, i) => {
    const other = b[i]
    if (op.kind !== other.kind) return false
    if (op.kind === 'text' && other.kind === 'text') return op.after === other.after
    return JSON.stringify(op) === JSON.stringify(other)
  })
}
