import type { ReactNode } from 'react'
import { ForgeDesignMode } from 'the-forge/design-mode'
import './globals.css'

export const metadata = {
  title: 'next-demo',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ForgeDesignMode />
      </body>
    </html>
  )
}
