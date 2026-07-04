import type { AppProps } from 'next/app'
import { ForgeDesignMode } from 'the-forge/design-mode'

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Component {...pageProps} />
      <ForgeDesignMode />
    </>
  )
}
