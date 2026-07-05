// The bare package root has no useful export — Vite users import 'the-forge/vite', Next
// users import 'the-forge/next'. Throwing at module evaluation (rather than exporting
// nothing) turns an accidental bare import into a loud, immediate failure instead of a
// silent no-op.
throw new Error("the-forge has no root export — import 'the-forge/vite' or 'the-forge/next'")

// Explicit empty export marks this file an ES module (not a script) so TS's isolatedModules
// / import() typing treats it correctly — has no effect on the runtime throw above.
export {}
