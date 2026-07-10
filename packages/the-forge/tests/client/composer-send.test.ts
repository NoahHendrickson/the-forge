// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { SessionFeed } from '../../src/client/session-feed'
import { ComposerSend } from '../../src/client/composer-send'

// Unit coverage for the send-everything verb's orchestration + chat leg, extracted out of
// index.ts's DesignMode by the composer-send extraction review round. design-mode.test.ts still
// covers the end-to-end wiring (real DesignMode + fetch mocks + DOM clicks) — these tests drive
// ComposerSend directly against a real SessionFeed (so getText/getChip/clearText/setChip behave
// exactly as production wiring sees them) with a stubbed postJson/sendDraftsLeg, to pin the verb
// matrix close to the code that implements it.

function textareaOf(feed: SessionFeed): HTMLTextAreaElement {
  return feed.root.querySelector('.chat-textarea') as HTMLTextAreaElement
}

function chipOf(feed: SessionFeed): HTMLElement {
  return feed.root.querySelector('.chat-chip') as HTMLElement
}

function setup(overrides: Partial<{ sendDraftsLeg: () => Promise<void>; hasDrafts: () => boolean; chatAvailable: () => boolean }> = {}) {
  const feed = new SessionFeed()
  document.body.appendChild(feed.root)
  const postJson = vi.fn<(path: string, body: unknown) => Promise<Response>>()
  const sendDraftsLeg = overrides.sendDraftsLeg ?? vi.fn(() => Promise.resolve())
  const hasDrafts = overrides.hasDrafts ?? (() => false)
  const chatAvailable = overrides.chatAvailable ?? (() => true)
  const composerSend = new ComposerSend({ feed, postJson, sendDraftsLeg, hasDrafts, chatAvailable })
  return { feed, postJson, sendDraftsLeg, composerSend }
}

function okResponse(): Response {
  return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response
}

describe('ComposerSend#send — orchestration', () => {
  it('text only, no drafts: POSTs /session/say and never calls sendDraftsLeg', async () => {
    const { feed, postJson, sendDraftsLeg, composerSend } = setup()
    textareaOf(feed).value = 'hello there'
    postJson.mockResolvedValue(okResponse())

    composerSend.send()
    await Promise.resolve()

    expect(sendDraftsLeg).not.toHaveBeenCalled()
    expect(postJson).toHaveBeenCalledWith('/__the-forge/session/say', { text: 'hello there', element: undefined })
  })

  it('drafts only, empty textarea: calls sendDraftsLeg and never POSTs /session/say', async () => {
    const { feed, postJson, sendDraftsLeg, composerSend } = setup({ hasDrafts: () => true })
    void feed // textarea stays empty

    composerSend.send()
    for (let i = 0; i < 4; i++) await Promise.resolve()

    expect(sendDraftsLeg).toHaveBeenCalledTimes(1)
    expect(postJson).not.toHaveBeenCalled()
  })

  it('both drafts and text: awaits sendDraftsLeg before POSTing /session/say (drafts-first ordering)', async () => {
    let resolveLeg!: () => void
    const sendDraftsLeg = vi.fn(() => new Promise<void>((resolve) => (resolveLeg = resolve)))
    const { feed, postJson, composerSend } = setup({ sendDraftsLeg, hasDrafts: () => true })
    textareaOf(feed).value = 'also do this'
    postJson.mockResolvedValue(okResponse())

    composerSend.send()
    await Promise.resolve()
    expect(postJson).not.toHaveBeenCalled() // chat leg must not fire before the drafts leg settles

    resolveLeg()
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(postJson).toHaveBeenCalledWith('/__the-forge/session/say', { text: 'also do this', element: undefined })
  })

  it('chatAvailable:false skips the chat leg even with non-empty text', async () => {
    const { feed, postJson, composerSend } = setup({ chatAvailable: () => false })
    textareaOf(feed).value = 'should not send'

    composerSend.send()
    for (let i = 0; i < 4; i++) await Promise.resolve()

    expect(postJson).not.toHaveBeenCalled()
  })

  it('captures text at call time — a later change to feed state does not affect the pending chat POST', async () => {
    let resolveLeg!: () => void
    const sendDraftsLeg = vi.fn(() => new Promise<void>((resolve) => (resolveLeg = resolve)))
    const { feed, postJson, composerSend } = setup({ sendDraftsLeg, hasDrafts: () => true })
    textareaOf(feed).value = 'original message'
    postJson.mockResolvedValue(okResponse())

    composerSend.send()
    await Promise.resolve()
    textareaOf(feed).value = '' // user clears mid-flight — must not affect what gets said
    resolveLeg()
    for (let i = 0; i < 4; i++) await Promise.resolve()

    expect(postJson).toHaveBeenCalledWith('/__the-forge/session/say', { text: 'original message', element: undefined })
  })

  it('includes the chipped element in the request body', async () => {
    const { feed, postJson, composerSend } = setup()
    feed.setChip({ source: 'src/App.tsx:12:3', tag: 'div', label: 'div · App.tsx:12' })
    textareaOf(feed).value = 'make it bigger'
    postJson.mockResolvedValue(okResponse())

    composerSend.send()
    await Promise.resolve()

    expect(postJson).toHaveBeenCalledWith('/__the-forge/session/say', {
      text: 'make it bigger',
      element: { source: 'src/App.tsx:12:3', tag: 'div' },
    })
  })
})

describe('ComposerSend — chat leg result handling', () => {
  it('a successful response clears the textarea only when unchanged, and always clears the chip', async () => {
    const { feed, postJson, composerSend } = setup()
    feed.setChip({ source: 'src/App.tsx:1:1', tag: 'div', label: 'div' })
    textareaOf(feed).value = 'send me'
    postJson.mockResolvedValue(okResponse())

    composerSend.send()
    for (let i = 0; i < 4; i++) await Promise.resolve()

    expect(textareaOf(feed).value).toBe('')
    expect(chipOf(feed).hidden).toBe(true)
  })

  it('text retyped during the round trip is NOT wiped on success', async () => {
    let resolveSay!: (v: Response) => void
    const postJson = vi.fn(() => new Promise<Response>((resolve) => (resolveSay = resolve)))
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    const composerSend = new ComposerSend({ feed, postJson, sendDraftsLeg: () => Promise.resolve(), hasDrafts: () => false, chatAvailable: () => true })
    textareaOf(feed).value = 'original message'

    composerSend.send()
    await Promise.resolve()
    textareaOf(feed).value = 'retyped while waiting'
    resolveSay(okResponse())
    for (let i = 0; i < 4; i++) await Promise.resolve()

    expect(textareaOf(feed).value).toBe('retyped while waiting')
  })

  it('429 renders the queue-full copy and leaves the typed text untouched', async () => {
    const { feed, postJson, composerSend } = setup()
    textareaOf(feed).value = 'hello'
    postJson.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) } as unknown as Response)

    composerSend.send()
    for (let i = 0; i < 4; i++) await Promise.resolve()

    const errorRow = feed.root.querySelector('.session-error-row')
    expect(errorRow?.textContent).toBe('chat queue full — wait for the current turn')
    expect(textareaOf(feed).value).toBe('hello')
  })

  it('a non-429 non-ok response renders the generic retry copy', async () => {
    const { feed, postJson, composerSend } = setup()
    textareaOf(feed).value = 'hello'
    postJson.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)

    composerSend.send()
    for (let i = 0; i < 4; i++) await Promise.resolve()

    const errorRow = feed.root.querySelector('.session-error-row')
    expect(errorRow?.textContent).toBe('message failed to send — try again')
    expect(textareaOf(feed).value).toBe('hello')
  })

  it('a network failure (rejected promise) renders the generic retry copy', async () => {
    const { feed, postJson, composerSend } = setup()
    textareaOf(feed).value = 'hello'
    postJson.mockRejectedValue(new Error('network down'))

    composerSend.send()
    for (let i = 0; i < 4; i++) await Promise.resolve()

    const errorRow = feed.root.querySelector('.session-error-row')
    expect(errorRow?.textContent).toBe('message failed to send — try again')
    expect(textareaOf(feed).value).toBe('hello')
  })

  it('double send with a chat POST in flight produces exactly ONE /session/say POST (chatInFlight guard)', async () => {
    let resolveSay!: (v: Response) => void
    const { feed, postJson, composerSend } = setup()
    postJson.mockImplementation(() => new Promise<Response>((resolve) => (resolveSay = resolve)))
    textareaOf(feed).value = 'hello there'

    composerSend.send()
    await Promise.resolve() // first POST in flight, unresolved
    composerSend.send() // second call before the first round trip settles
    await Promise.resolve()
    resolveSay(okResponse())
    for (let i = 0; i < 4; i++) await Promise.resolve()

    expect(postJson).toHaveBeenCalledTimes(1)
  })

  it('empty/whitespace-only text never POSTs, even when chatAvailable', async () => {
    const { feed, postJson, composerSend } = setup()
    textareaOf(feed).value = '   '

    composerSend.send()
    for (let i = 0; i < 4; i++) await Promise.resolve()

    expect(postJson).not.toHaveBeenCalled()
  })
})
