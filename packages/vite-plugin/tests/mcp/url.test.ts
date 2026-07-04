import { describe, it, expect } from 'vitest'
import { baseUrl } from '../../src/mcp/url'

describe('baseUrl', () => {
  it('defaults to 127.0.0.1 when no host is given', () => {
    expect(baseUrl({ port: 5173 })).toBe('http://127.0.0.1:5173')
  })

  it('wraps IPv6 hosts in brackets', () => {
    expect(baseUrl({ port: 5173, host: '::1' })).toBe('http://[::1]:5173')
  })

  it('treats the IPv6 wildcard (::) as loopback ::1', () => {
    expect(baseUrl({ port: 5173, host: '::' })).toBe('http://[::1]:5173')
  })

  it('treats the IPv4 wildcard (0.0.0.0) as loopback 127.0.0.1', () => {
    expect(baseUrl({ port: 5173, host: '0.0.0.0' })).toBe('http://127.0.0.1:5173')
  })

  it('uses the host as-is for a plain IPv4 host', () => {
    expect(baseUrl({ port: 5173, host: '127.0.0.1' })).toBe('http://127.0.0.1:5173')
  })
})
