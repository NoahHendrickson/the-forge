// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  clampWidth,
  loadPrefs,
  savePrefs,
  MIN_WIDTH,
  MAX_WIDTH,
  DEFAULT_WIDTH,
  STORAGE_KEY,
} from '../../src/client/dock'

beforeEach(() => {
  localStorage.clear()
})

describe('clampWidth', () => {
  it('passes through in-range widths', () => {
    expect(clampWidth(320, 1280)).toBe(320)
  })
  it('clamps below MIN_WIDTH up to 280', () => {
    expect(clampWidth(100, 1280)).toBe(MIN_WIDTH)
  })
  it('clamps above MAX_WIDTH down to 560', () => {
    expect(clampWidth(900, 1280)).toBe(MAX_WIDTH)
  })
  it('caps at 50% of the viewport when that is below MAX_WIDTH', () => {
    expect(clampWidth(560, 800)).toBe(400)
  })
  it('MIN wins over the 50vw cap on tiny viewports (usable panel beats visible page)', () => {
    expect(clampWidth(320, 400)).toBe(MIN_WIDTH)
  })
})

describe('loadPrefs / savePrefs', () => {
  it('defaults to docked / DEFAULT_WIDTH when storage is empty', () => {
    expect(loadPrefs()).toEqual({ width: DEFAULT_WIDTH, mode: 'docked' })
  })
  it('round-trips savePrefs -> loadPrefs', () => {
    savePrefs({ width: 400, mode: 'floating' })
    expect(loadPrefs()).toEqual({ width: 400, mode: 'floating' })
  })
  it('falls back to defaults on corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    expect(loadPrefs()).toEqual({ width: DEFAULT_WIDTH, mode: 'docked' })
  })
  it('falls back per-field on wrong types and unknown modes', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: 'wide', mode: 'sideways' }))
    expect(loadPrefs()).toEqual({ width: DEFAULT_WIDTH, mode: 'docked' })
  })
  it('re-clamps a stored width against the current viewport', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: 5000, mode: 'docked' }))
    expect(loadPrefs().width).toBeLessThanOrEqual(MAX_WIDTH)
  })
})
