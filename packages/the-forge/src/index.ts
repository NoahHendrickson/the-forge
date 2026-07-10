// The bare package root has no useful export — Vite users import 'forge-mode/vite', Next
// users import 'forge-mode/next'. Throwing at module evaluation (rather than exporting
// nothing) turns an accidental bare import into a loud, immediate failure instead of a
// silent no-op.
throw new Error("forge-mode has no root export — import 'forge-mode/vite' or 'forge-mode/next'")

// Explicit empty export marks this file an ES module (not a script) so TS's isolatedModules
// / import() typing treats it correctly — has no effect on the runtime throw above.
export {}
