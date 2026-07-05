import { describe, it, expect } from 'vitest'
import {
  addViteForgePlugin,
  wrapNextConfigExport,
  mountDesignMode,
} from '../../src/cli/edits'

describe('addViteForgePlugin', () => {
  it('edits the real demo-app vite.config.ts shape (defineConfig + literal plugins array)', () => {
    const source = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
})
`
    const result = addViteForgePlugin(source)
    expect(result.kind).toBe('edited')
    if (result.kind !== 'edited') throw new Error('unreachable')

    expect(result.code).toContain(`import { theForge } from 'the-forge/vite'`)
    expect(result.code).toContain(`plugins: [theForge(), react(), tailwindcss()],`)

    // Rest of the source is byte-identical once the inserted import line and
    // the inserted "theForge(), " token are removed.
    const withoutImport = result.code.replace(
      `import { theForge } from 'the-forge/vite'\n`,
      ''
    )
    const withoutPlugin = withoutImport.replace('theForge(), ', '')
    expect(withoutPlugin).toBe(source)
  })

  it('edits a bare object expression default export with no other imports', () => {
    const source = `export default {\n  plugins: [react()],\n}\n`
    const result = addViteForgePlugin(source)
    expect(result.kind).toBe('edited')
    if (result.kind !== 'edited') throw new Error('unreachable')

    expect(result.code).toContain(`import { theForge } from 'the-forge/vite'`)
    expect(result.code).toContain(`plugins: [theForge(), react()],`)

    const withoutImport = result.code.replace(
      `import { theForge } from 'the-forge/vite'\n\n`,
      ''
    )
    const withoutPlugin = withoutImport.replace('theForge(), ', '')
    expect(withoutPlugin).toBe(source)
  })

  it('is idempotent: already-edited output reports already', () => {
    const source = `import { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n`
    const first = addViteForgePlugin(source)
    expect(first.kind).toBe('edited')
    if (first.kind !== 'edited') throw new Error('unreachable')
    const second = addViteForgePlugin(first.code)
    expect(second).toEqual({ kind: 'already' })
  })

  it('falls back when there is no default export', () => {
    const source = `export const config = { plugins: [react()] }\n`
    const result = addViteForgePlugin(source)
    expect(result.kind).toBe('fallback')
    if (result.kind !== 'fallback') throw new Error('unreachable')
    expect(result.reason.length).toBeGreaterThan(0)
    expect((result as { code?: string }).code).toBeUndefined()
  })

  it('falls back on a defineConfig(() => ...) factory', () => {
    const source = `import { defineConfig } from 'vite'\n\nexport default defineConfig(() => ({\n  plugins: [react()],\n}))\n`
    const result = addViteForgePlugin(source)
    expect(result.kind).toBe('fallback')
    if (result.kind !== 'fallback') throw new Error('unreachable')
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('falls back when plugins is missing', () => {
    const source = `import { defineConfig } from 'vite'\n\nexport default defineConfig({\n  base: '/app/',\n})\n`
    const result = addViteForgePlugin(source)
    expect(result.kind).toBe('fallback')
  })

  it('falls back when plugins is computed rather than a literal array', () => {
    const source = `import { defineConfig } from 'vite'\nconst plugins = [react()]\n\nexport default defineConfig({\n  plugins,\n})\n`
    const result = addViteForgePlugin(source)
    expect(result.kind).toBe('fallback')
  })

  it('falls back on a re-export default', () => {
    const source = `export { default } from './base.config'\n`
    const result = addViteForgePlugin(source)
    expect(result.kind).toBe('fallback')
  })

  it('reports already when the-forge/vite is already imported', () => {
    const source = `import { theForge } from 'the-forge/vite'\nimport { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [theForge(), react()],\n})\n`
    const result = addViteForgePlugin(source)
    expect(result).toEqual({ kind: 'already' })
  })

  it('handles spreads/calls inside the plugins array (insertion at index 0 still exact)', () => {
    const source = `import { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [...extraPlugins(), react()],\n})\n`
    const result = addViteForgePlugin(source)
    expect(result.kind).toBe('edited')
    if (result.kind !== 'edited') throw new Error('unreachable')
    expect(result.code).toContain(`plugins: [theForge(), ...extraPlugins(), react()],`)
  })

  it('falls back on unparseable input', () => {
    const result = addViteForgePlugin('{{{ not valid')
    expect(result.kind).toBe('fallback')
    if (result.kind !== 'fallback') throw new Error('unreachable')
    expect(result.reason.length).toBeGreaterThan(0)
  })
})

describe('wrapNextConfigExport', () => {
  it('edits the real next-demo next.config.ts shape (bare call default export)', () => {
    // next.config.ts today is `export default withForge()`; stripped of the
    // forge line the "before install" shape is a bare call expression.
    const source = `import type { NextConfig } from 'next'\n\nconst nextConfig: NextConfig = {}\n\nexport default nextConfig\n`
    const result = wrapNextConfigExport(source)
    expect(result.kind).toBe('edited')
    if (result.kind !== 'edited') throw new Error('unreachable')

    expect(result.code).toContain(`import { withForge } from 'the-forge/next'`)
    expect(result.code).toContain(`export default withForge(nextConfig)`)

    const withoutImport = result.code.replace(
      `import { withForge } from 'the-forge/next'\n`,
      ''
    )
    const withoutWrap = withoutImport.replace('withForge(nextConfig)', 'nextConfig')
    expect(withoutWrap).toBe(source)
  })

  it('edits a bare object literal default export', () => {
    const source = `export default {}\n`
    const result = wrapNextConfigExport(source)
    expect(result.kind).toBe('edited')
    if (result.kind !== 'edited') throw new Error('unreachable')
    expect(result.code).toContain(`import { withForge } from 'the-forge/next'`)
    expect(result.code).toContain(`export default withForge({})`)
  })

  it('edits CJS module.exports = <expr>, inserting a require at the top of the file', () => {
    const source = `/** @type {import('next').NextConfig} */\nconst nextConfig = {}\n\nmodule.exports = nextConfig\n`
    const result = wrapNextConfigExport(source)
    expect(result.kind).toBe('edited')
    if (result.kind !== 'edited') throw new Error('unreachable')

    expect(result.code).toContain(`const { withForge } = require('the-forge/next')`)
    expect(result.code).toContain(`module.exports = withForge(nextConfig)`)
    expect(result.code.indexOf(`require('the-forge/next')`)).toBeLessThan(
      result.code.indexOf('/** @type')
    )

    const withoutImport = result.code.replace(
      `const { withForge } = require('the-forge/next')\n\n`,
      ''
    )
    const withoutWrap = withoutImport.replace('withForge(nextConfig)', 'nextConfig')
    expect(withoutWrap).toBe(source)
  })

  it('inserts the CJS require after a leading "use strict" directive, not before it', () => {
    const source = `'use strict'\n\nconst nextConfig = {}\n\nmodule.exports = nextConfig\n`
    const result = wrapNextConfigExport(source)
    expect(result.kind).toBe('edited')
    if (result.kind !== 'edited') throw new Error('unreachable')

    expect(result.code.startsWith(`'use strict'`)).toBe(true)
    expect(result.code.indexOf(`'use strict'`)).toBeLessThan(
      result.code.indexOf(`require('the-forge/next')`)
    )
    expect(result.code).toContain(`module.exports = withForge(nextConfig)`)
  })

  it('wraps an identifier default export', () => {
    const source = `const config = {}\n\nexport default config\n`
    const result = wrapNextConfigExport(source)
    expect(result.kind).toBe('edited')
    if (result.kind !== 'edited') throw new Error('unreachable')
    expect(result.code).toContain(`export default withForge(config)`)
  })

  it('wraps a call-expression default export (any expression, not just objects/identifiers)', () => {
    const source = `import { loadConfig } from './load-config'\n\nexport default loadConfig()\n`
    const result = wrapNextConfigExport(source)
    expect(result.kind).toBe('edited')
    if (result.kind !== 'edited') throw new Error('unreachable')
    expect(result.code).toContain(`export default withForge(loadConfig())`)

    const withoutImport = result.code.replace(
      `import { withForge } from 'the-forge/next'\n`,
      ''
    )
    const withoutWrap = withoutImport.replace('withForge(loadConfig())', 'loadConfig()')
    expect(withoutWrap).toBe(source)
  })

  it('is idempotent: already-edited output reports already', () => {
    const source = `export default {}\n`
    const first = wrapNextConfigExport(source)
    expect(first.kind).toBe('edited')
    if (first.kind !== 'edited') throw new Error('unreachable')
    const second = wrapNextConfigExport(first.code)
    expect(second).toEqual({ kind: 'already' })
  })

  it('reports already when the-forge/next is already imported', () => {
    const source = `import { withForge } from 'the-forge/next'\n\nexport default withForge({})\n`
    const result = wrapNextConfigExport(source)
    expect(result).toEqual({ kind: 'already' })
  })

  it('falls back when there is no recognizable export', () => {
    const source = `const nextConfig = {}\n`
    const result = wrapNextConfigExport(source)
    expect(result.kind).toBe('fallback')
    if (result.kind !== 'fallback') throw new Error('unreachable')
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('falls back on export default of a function declaration', () => {
    const source = `export default function config() {\n  return {}\n}\n`
    const result = wrapNextConfigExport(source)
    expect(result.kind).toBe('fallback')
    if (result.kind !== 'fallback') throw new Error('unreachable')
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('falls back on unparseable input', () => {
    const result = wrapNextConfigExport('{{{ not valid')
    expect(result.kind).toBe('fallback')
    if (result.kind !== 'fallback') throw new Error('unreachable')
    expect(result.reason.length).toBeGreaterThan(0)
  })
})

describe('mountDesignMode (app router)', () => {
  it('edits the real next-demo app/layout.tsx shape', () => {
    const source = `import type { ReactNode } from 'react'
import './globals.css'

export const metadata = {
  title: 'next-demo',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  )
}
`
    const result = mountDesignMode(source, 'app')
    expect(result.kind).toBe('edited')
    if (result.kind !== 'edited') throw new Error('unreachable')

    expect(result.code).toContain(
      `import { ForgeDesignMode } from 'the-forge/design-mode'`
    )
    expect(result.code).toContain(`        <ForgeDesignMode />\n        {children}`)

    const withoutImport = result.code.replace(
      `import { ForgeDesignMode } from 'the-forge/design-mode'\n`,
      ''
    )
    const withoutMount = withoutImport.replace(`        <ForgeDesignMode />\n`, '')
    expect(withoutMount).toBe(source)
  })

  it('is idempotent: already-edited output reports already', () => {
    const source = `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html>\n      <body>\n        {children}\n      </body>\n    </html>\n  )\n}\n`
    const first = mountDesignMode(source, 'app')
    expect(first.kind).toBe('edited')
    if (first.kind !== 'edited') throw new Error('unreachable')
    const second = mountDesignMode(first.code, 'app')
    expect(second).toEqual({ kind: 'already' })
  })

  it('puts the mount on its own line, indented past <body>, when children are on the same line as <body>', () => {
    const source = `export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  )\n}\n`
    const result = mountDesignMode(source, 'app')
    expect(result.kind).toBe('edited')
    if (result.kind !== 'edited') throw new Error('unreachable')

    expect(result.code).toContain(`      <body>\n        <ForgeDesignMode />{children}</body>`)
  })

  it('reports already when the-forge/design-mode is already imported', () => {
    const source = `import { ForgeDesignMode } from 'the-forge/design-mode'\n\nexport default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>\n        <ForgeDesignMode />\n        {children}\n      </body>\n    </html>\n  )\n}\n`
    const result = mountDesignMode(source, 'app')
    expect(result).toEqual({ kind: 'already' })
  })

  it('falls back when there is no literal <body> in the file', () => {
    const source = `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <Providers>{children}</Providers>\n}\n`
    const result = mountDesignMode(source, 'app')
    expect(result.kind).toBe('fallback')
    if (result.kind !== 'fallback') throw new Error('unreachable')
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('falls back when there is more than one <body> element (ambiguous target)', () => {
    const source = `export default function RootLayout({ children }: { children: React.ReactNode }) {
  if (children) {
    return (
      <html>
        <body>
          {children}
        </body>
      </html>
    )
  }
  return (
    <html>
      <body>
        <p>fallback</p>
      </body>
    </html>
  )
}
`
    const result = mountDesignMode(source, 'app')
    expect(result.kind).toBe('fallback')
    if (result.kind !== 'fallback') throw new Error('unreachable')
    expect(result.reason).toContain('expected exactly one <body> element, found 2')
    expect((result as { code?: string }).code).toBeUndefined()
  })

  it('falls back on unparseable input', () => {
    const result = mountDesignMode('{{{ not valid', 'app')
    expect(result.kind).toBe('fallback')
    if (result.kind !== 'fallback') throw new Error('unreachable')
    expect(result.reason.length).toBeGreaterThan(0)
  })
})

describe('mountDesignMode (pages router)', () => {
  it('edits the real next-pages _app.tsx shape (existing fragment)', () => {
    const source = `import type { AppProps } from 'next/app'

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Component {...pageProps} />
    </>
  )
}
`
    const result = mountDesignMode(source, 'pages')
    expect(result.kind).toBe('edited')
    if (result.kind !== 'edited') throw new Error('unreachable')

    expect(result.code).toContain(
      `import { ForgeDesignMode } from 'the-forge/design-mode'`
    )
    expect(result.code).toContain(
      `      <Component {...pageProps} />\n      <ForgeDesignMode />`
    )

    const withoutImport = result.code.replace(
      `import { ForgeDesignMode } from 'the-forge/design-mode'\n`,
      ''
    )
    const withoutMount = withoutImport.replace(`\n      <ForgeDesignMode />`, '')
    expect(withoutMount).toBe(source)
  })

  it('wraps a bare <Component/> return expression in a fragment', () => {
    const source = `import type { AppProps } from 'next/app'

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />
}
`
    const result = mountDesignMode(source, 'pages')
    expect(result.kind).toBe('edited')
    if (result.kind !== 'edited') throw new Error('unreachable')

    expect(result.code).toContain(
      `import { ForgeDesignMode } from 'the-forge/design-mode'`
    )
    expect(result.code).toContain(
      `<><Component {...pageProps} /><ForgeDesignMode /></>`
    )

    const withoutImport = result.code.replace(
      `import { ForgeDesignMode } from 'the-forge/design-mode'\n`,
      ''
    )
    const withoutWrap = withoutImport.replace(
      `<><Component {...pageProps} /><ForgeDesignMode /></>`,
      `<Component {...pageProps} />`
    )
    expect(withoutWrap).toBe(source)
  })

  it('is idempotent: already-edited output (existing-fragment case) reports already', () => {
    const source = `export default function App({ Component, pageProps }) {\n  return (\n    <>\n      <Component {...pageProps} />\n    </>\n  )\n}\n`
    const first = mountDesignMode(source, 'pages')
    expect(first.kind).toBe('edited')
    if (first.kind !== 'edited') throw new Error('unreachable')
    const second = mountDesignMode(first.code, 'pages')
    expect(second).toEqual({ kind: 'already' })
  })

  it('is idempotent: already-edited output (bare-return case) reports already', () => {
    const source = `export default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />\n}\n`
    const first = mountDesignMode(source, 'pages')
    expect(first.kind).toBe('edited')
    if (first.kind !== 'edited') throw new Error('unreachable')
    const second = mountDesignMode(first.code, 'pages')
    expect(second).toEqual({ kind: 'already' })
  })

  it('reports already when the-forge/design-mode is already imported', () => {
    const source = `import { ForgeDesignMode } from 'the-forge/design-mode'\n\nexport default function App({ Component, pageProps }) {\n  return (\n    <>\n      <Component {...pageProps} />\n      <ForgeDesignMode />\n    </>\n  )\n}\n`
    const result = mountDesignMode(source, 'pages')
    expect(result).toEqual({ kind: 'already' })
  })

  it('falls back when there is no <Component> element found', () => {
    const source = `export default function App({ Component, pageProps }) {\n  const Page = Component\n  return <Page {...pageProps} />\n}\n`
    const result = mountDesignMode(source, 'pages')
    expect(result.kind).toBe('fallback')
    if (result.kind !== 'fallback') throw new Error('unreachable')
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('falls back when there is more than one <Component> element (ambiguous target)', () => {
    const source = `import type { AppProps } from 'next/app'

export default function App({ Component, pageProps }: AppProps) {
  if (pageProps.noLayout) {
    return <Component {...pageProps} />
  }
  return (
    <Layout>
      <Component {...pageProps} />
    </Layout>
  )
}
`
    const result = mountDesignMode(source, 'pages')
    expect(result.kind).toBe('fallback')
    if (result.kind !== 'fallback') throw new Error('unreachable')
    expect(result.reason).toContain('expected exactly one <Component> element, found 2')
    expect((result as { code?: string }).code).toBeUndefined()
  })
})
