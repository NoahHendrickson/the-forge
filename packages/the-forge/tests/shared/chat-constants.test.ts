import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  type HarnessId,
  EMBEDDED_HARNESSES,
  type HarnessVocab,
  HARNESS_VOCAB,
  EFFORT_LEVELS,
  PERMISSION_MODES,
  CHAT_TEXT_MAX,
} from '../../src/shared/chat-constants'

const SRC_FILE = path.join(__dirname, '../../src/shared/chat-constants.ts')

describe('chat-constants: pure data, zero imports (bundled into both server and browser bundles)', () => {
  it('the source file contains no import statements', () => {
    const code = fs.readFileSync(SRC_FILE, 'utf8')
    expect(code).not.toMatch(/^\s*import\s/m)
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

describe('temporary re-export aliases (deleted in Tasks 4/5 when consumers move to HARNESS_VOCAB lookups)', () => {
  it('EFFORT_LEVELS aliases the claude-code effort vocab', () => {
    expect(EFFORT_LEVELS).toEqual(HARNESS_VOCAB['claude-code'].efforts)
  })

  it('PERMISSION_MODES aliases the claude-code permission-mode vocab', () => {
    expect(PERMISSION_MODES).toEqual(HARNESS_VOCAB['claude-code'].permissionModes)
  })
})

describe('CHAT_TEXT_MAX', () => {
  it('is 4000 (unchanged)', () => {
    expect(CHAT_TEXT_MAX).toBe(4000)
  })
})
