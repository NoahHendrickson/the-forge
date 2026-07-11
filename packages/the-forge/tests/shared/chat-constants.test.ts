import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  type HarnessId,
  EMBEDDED_HARNESSES,
  type HarnessVocab,
  HARNESS_VOCAB,
  CHAT_TEXT_MAX,
  isHarnessId,
} from '../../src/shared/chat-constants'

const SRC_FILE = path.join(__dirname, '../../src/shared/chat-constants.ts')

describe('chat-constants: pure data, zero imports (bundled into both server and browser bundles)', () => {
  it('the source file contains no import statements', () => {
    // Still holds with the isHarnessId guard exported — the no-imports rule is about module
    // dependencies leaking across the server/browser boundary, not about function exports.
    const code = fs.readFileSync(SRC_FILE, 'utf8')
    expect(code).not.toMatch(/^\s*import\s/m)
  })
})

describe('isHarnessId (the ONE shared runtime guard — manager/session-feed/watch/runtime all use it)', () => {
  it('accepts every EMBEDDED_HARNESSES member', () => {
    for (const h of EMBEDDED_HARNESSES) {
      expect(isHarnessId(h)).toBe(true)
    }
  })

  it('rejects non-embedded agents, non-strings, and absent values', () => {
    expect(isHarnessId('codex')).toBe(false) // known agent, but not embedded (until C2)
    expect(isHarnessId('')).toBe(false)
    expect(isHarnessId(42)).toBe(false)
    expect(isHarnessId(null)).toBe(false)
    expect(isHarnessId(undefined)).toBe(false)
    expect(isHarnessId(['claude-code'])).toBe(false)
  })
})

describe('HARNESS_VOCAB', () => {
  it('claude-code arrays are verbatim the previous EFFORT_LEVELS/PERMISSION_MODES values (regression pin)', () => {
    expect(HARNESS_VOCAB['claude-code'].efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(HARNESS_VOCAB['claude-code'].permissionModes).toEqual(['default', 'acceptEdits', 'plan'])
  })

  it('claude-code has liveEffort: false (spawn-flag-only, no set_effort control request)', () => {
    expect(HARNESS_VOCAB['claude-code'].liveEffort).toBe(false)
  })

  it('cursor vocab is empty tables — no effort knob, no verified ACP permission-mode control', () => {
    // Empty arrays hide both pickers (client) and reject every value (endpoint validation);
    // the ratified permission posture is enforced adapter-side instead.
    expect(HARNESS_VOCAB.cursor.efforts).toEqual([])
    expect(HARNESS_VOCAB.cursor.permissionModes).toEqual([])
  })

  it('cursor has liveEffort: true (moot with an empty efforts list; never triggers the Claude respawn dance)', () => {
    expect(HARNESS_VOCAB.cursor.liveEffort).toBe(true)
  })

  it('EMBEDDED_HARNESSES lists both harnesses', () => {
    expect(EMBEDDED_HARNESSES).toEqual(['claude-code', 'cursor'])
  })

  it('every HarnessId in EMBEDDED_HARNESSES has a HARNESS_VOCAB entry', () => {
    for (const h of EMBEDDED_HARNESSES) {
      const vocab: HarnessVocab = HARNESS_VOCAB[h as HarnessId]
      expect(vocab).toBeDefined()
      expect(Array.isArray(vocab.efforts)).toBe(true)
      expect(typeof vocab.liveEffort).toBe('boolean')
      expect(Array.isArray(vocab.permissionModes)).toBe(true)
    }
  })
})

describe('CHAT_TEXT_MAX', () => {
  it('is 4000 (unchanged)', () => {
    expect(CHAT_TEXT_MAX).toBe(4000)
  })
})
