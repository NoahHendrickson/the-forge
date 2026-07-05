import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ensureSidecarMock = vi.fn()

vi.mock('../../src/next/sidecar', () => ({
  ensureSidecar: (...args: unknown[]) => ensureSidecarMock(...args),
}))

// Imported after the mock so withForge picks up the mocked ensureSidecar.
import { withForge } from '../../src/next/index'

const PHASE_DEVELOPMENT_SERVER = 'phase-development-server'
const PHASE_PRODUCTION_BUILD = 'phase-production-build'

beforeEach(() => {
  ensureSidecarMock.mockReset()
  ensureSidecarMock.mockResolvedValue({ port: 4568, close: vi.fn() })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('withForge', () => {
  it('returns a function', () => {
    const wrapped = withForge()
    expect(typeof wrapped).toBe('function')
  })

  it('non-dev phase returns the user config identically (untouched, not cloned)', async () => {
    const userConfig = { reactStrictMode: true }
    const wrapped = withForge(userConfig)
    const result = await wrapped(PHASE_PRODUCTION_BUILD, { defaultConfig: {} })
    expect(result).toBe(userConfig)
  })

  it('non-dev phase with function-form user config still returns it untouched', async () => {
    const userConfig = { reactStrictMode: true }
    const userFn = vi.fn().mockReturnValue(userConfig)
    const wrapped = withForge(userFn)
    const ctx = { defaultConfig: {} }
    const result = await wrapped(PHASE_PRODUCTION_BUILD, ctx)
    expect(userFn).toHaveBeenCalledWith(PHASE_PRODUCTION_BUILD, ctx)
    expect(result).toBe(userConfig)
  })

  it('non-dev phase with no user config returns an empty-ish config untouched by forge', async () => {
    const wrapped = withForge()
    const result = await wrapped(PHASE_PRODUCTION_BUILD, { defaultConfig: {} })
    expect(result).not.toHaveProperty('turbopack')
    expect(result).not.toHaveProperty('rewrites')
  })

  it('dev phase sets ONLY top-level turbopack.rules (never experimental.turbo.rules)', async () => {
    const wrapped = withForge({})
    const result: any = await wrapped(PHASE_DEVELOPMENT_SERVER, { defaultConfig: {} })

    expect(result.turbopack).toBeDefined()
    expect(result.turbopack.rules).toBeDefined()
    const rule = result.turbopack.rules['*.{jsx,tsx}']
    // No `as` key: Turbopack has no `$1` glob-capture — `as: '*.$1'` panics Turbopack on a
    // real `next dev` (see the why-comment in src/next/index.ts; N6 smoke-gate finding).
    expect(rule.as).toBeUndefined()
    expect(rule.loaders).toHaveLength(1)
    expect(rule.loaders[0].loader).toMatch(/next-loader\.cjs$/)
    expect(rule.loaders[0].options).toEqual({ root: expect.any(String) })

    // Adjudication 1: the deprecated experimental.turbo.rules key must NOT be touched.
    expect(result.experimental).toBeUndefined()
  })

  it('dev phase chains the user webpack fn first, then unshifts the forge rule', async () => {
    const calls: string[] = []
    const userWebpack = vi.fn((config: any, _ctx: any) => {
      calls.push('user')
      config.module = config.module ?? { rules: [] }
      config.module.rules.push({ test: /\.css$/, use: ['css-loader'] })
      return config
    })
    const wrapped = withForge({ webpack: userWebpack })
    const result: any = await wrapped(PHASE_DEVELOPMENT_SERVER, { defaultConfig: {} })

    const config: any = { module: { rules: [] } }
    const ctx = { dev: true }
    const outConfig = result.webpack(config, ctx)

    expect(userWebpack).toHaveBeenCalledWith(config, ctx)
    expect(outConfig.module.rules).toHaveLength(2)
    // forge rule unshifted AFTER user's webpack ran, so it ends up first
    expect(outConfig.module.rules[0].test).toEqual(/\.[jt]sx$/)
    expect(outConfig.module.rules[0].exclude).toEqual(/node_modules/)
    expect(outConfig.module.rules[0].use[0].loader).toMatch(/next-loader\.cjs$/)
    expect(outConfig.module.rules[0].use[0].options).toEqual({ root: expect.any(String) })
    // `enforce: 'pre'` — found via the next-demo webpack E2E (N8a): Next's own next-swc-loader
    // is registered as a *separate*, later-in-array `oneOf` rule matching the same `.tsx`
    // test. Without `enforce: 'pre'`, webpack runs later-array-position rules' loaders BEFORE
    // earlier-position ones on the same request, so SWC transpiled JSX to
    // `_jsxDEV(...)` calls before our loader ever saw it — tagJsxSource found zero
    // JSXOpeningElement nodes (JSX syntax was already gone) and silently passed through
    // untagged source. `enforce: 'pre'` runs our loader in the pre-loader stage, ahead of
    // every normal-stage rule (including Next's SWC rule), guaranteeing it sees raw JSX —
    // matching the Turbopack path, where forgeLoader is the only registered transform.
    expect(outConfig.module.rules[0].enforce).toBe('pre')
    expect(outConfig.module.rules[1].test).toEqual(/\.css$/)
  })

  it('dev phase webpack chaining works when user has no webpack fn and config.module is absent', async () => {
    const wrapped = withForge({})
    const result: any = await wrapped(PHASE_DEVELOPMENT_SERVER, { defaultConfig: {} })

    const config: any = {}
    const outConfig = result.webpack(config, { dev: true })
    expect(outConfig.module.rules).toHaveLength(1)
    expect(outConfig.module.rules[0].test).toEqual(/\.[jt]sx$/)
    expect(outConfig.module.rules[0].enforce).toBe('pre')
  })

  it('rewrites: user had none -> forge-only array', async () => {
    const wrapped = withForge({})
    const result: any = await wrapped(PHASE_DEVELOPMENT_SERVER, { defaultConfig: {} })

    const rewrites = await result.rewrites()
    expect(rewrites).toEqual([
      { source: '/__the-forge/:path*', destination: 'http://127.0.0.1:4568/__the-forge/:path*' },
    ])
  })

  it('rewrites: user array form -> forge-first array with user entries intact', async () => {
    const userRewrite = { source: '/api/:path*', destination: 'https://example.com/:path*' }
    const userRewritesFn = vi.fn().mockResolvedValue([userRewrite])
    const wrapped = withForge({ rewrites: userRewritesFn })
    const result: any = await wrapped(PHASE_DEVELOPMENT_SERVER, { defaultConfig: {} })

    const rewrites = await result.rewrites()
    expect(userRewritesFn).toHaveBeenCalledTimes(1)
    expect(rewrites).toEqual([
      { source: '/__the-forge/:path*', destination: 'http://127.0.0.1:4568/__the-forge/:path*' },
      userRewrite,
    ])
  })

  it('rewrites: user object form -> forge prepended to beforeFiles, afterFiles/fallback intact', async () => {
    const beforeFilesRewrite = { source: '/before/:path*', destination: 'https://example.com/before/:path*' }
    const afterFilesRewrite = { source: '/after/:path*', destination: 'https://example.com/after/:path*' }
    const fallbackRewrite = { source: '/fallback/:path*', destination: 'https://example.com/fallback/:path*' }
    const userRewritesFn = vi.fn().mockResolvedValue({
      beforeFiles: [beforeFilesRewrite],
      afterFiles: [afterFilesRewrite],
      fallback: [fallbackRewrite],
    })
    const wrapped = withForge({ rewrites: userRewritesFn })
    const result: any = await wrapped(PHASE_DEVELOPMENT_SERVER, { defaultConfig: {} })

    const rewrites = await result.rewrites()
    expect(rewrites).toEqual({
      beforeFiles: [
        { source: '/__the-forge/:path*', destination: 'http://127.0.0.1:4568/__the-forge/:path*' },
        beforeFilesRewrite,
      ],
      afterFiles: [afterFilesRewrite],
      fallback: [fallbackRewrite],
    })
  })

  it('function-form user config receives (phase, ctx) passthrough', async () => {
    const userConfig = {}
    const userFn = vi.fn().mockReturnValue(userConfig)
    const wrapped = withForge(userFn)
    const ctx = { defaultConfig: { foo: 'bar' } }

    await wrapped(PHASE_DEVELOPMENT_SERVER, ctx)
    expect(userFn).toHaveBeenCalledWith(PHASE_DEVELOPMENT_SERVER, ctx)
  })

  it('function-form user config may return a Promise<config>, awaited before gating on phase', async () => {
    const userConfig = { reactStrictMode: true }
    const userFn = vi.fn().mockResolvedValue(userConfig)
    const wrapped = withForge(userFn)
    const result = await wrapped(PHASE_PRODUCTION_BUILD, { defaultConfig: {} })
    expect(result).toBe(userConfig)
  })

  it('options default to claude-code/false and thread into ensureSidecar args', async () => {
    const wrapped = withForge({})
    const result: any = await wrapped(PHASE_DEVELOPMENT_SERVER, { defaultConfig: {} })
    await result.rewrites()

    expect(ensureSidecarMock).toHaveBeenCalledTimes(1)
    const args = ensureSidecarMock.mock.calls[0][0]
    expect(args.agent).toBe('claude-code')
    expect(args.channelsFlag).toBe(false)
    expect(typeof args.root).toBe('string')
  })

  it('options thread custom agent/experimentalChannels into ensureSidecar args', async () => {
    const wrapped = withForge({}, { agent: 'cursor', experimentalChannels: true })
    const result: any = await wrapped(PHASE_DEVELOPMENT_SERVER, { defaultConfig: {} })
    await result.rewrites()

    const args = ensureSidecarMock.mock.calls[0][0]
    expect(args.agent).toBe('cursor')
    expect(args.channelsFlag).toBe(true)
  })

  it('ensureSidecar rejection -> warns once, returns user rewrites intact, never throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ensureSidecarMock.mockRejectedValue(new Error('EADDRNOTAVAIL boom'))

    const userRewrite = { source: '/api/:path*', destination: 'https://example.com/:path*' }
    const userRewritesFn = vi.fn().mockResolvedValue([userRewrite])
    const wrapped = withForge({ rewrites: userRewritesFn })
    const result: any = await wrapped(PHASE_DEVELOPMENT_SERVER, { defaultConfig: {} })

    const rewrites = await result.rewrites()
    expect(rewrites).toEqual([userRewrite])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('[the-forge] could not start')
    expect(warnSpy.mock.calls[0][0]).toContain('EADDRNOTAVAIL boom')

    warnSpy.mockRestore()
  })
})
