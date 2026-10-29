import { describe, expect, it } from 'vitest'

import { splitPeerSourceMessages } from '../../src/lib/peer-source'

/** A user message shaped the way the delivery path writes it. */
const message = (parts: Array<{ type: string; text: string }>, patch: Record<string, unknown> = {}) => ({
  id: 'message-1',
  role: 'user',
  source: { kind: 'user', rpcId: 'rpc-1' },
  content: parts,
  ...patch,
})

const text = (value: string) => ({ type: 'text', text: value })

describe('splitPeerSourceMessages', () => {
  it('moves the header into its own notice and leaves the body clean', () => {
    // The delivery writes the header and the body as two parts, so the hop to a
    // notice is a removal, not a parse of someone's prose.
    const delivered = message([
      text('<dsh_peer_source from="pm-assistant" session="session-9" conversation="REQ-1" />'),
      text('please review 12345'),
    ])

    const split = splitPeerSourceMessages([delivered], { newId: () => 'notice-1' })

    expect(split).not.toBeNull()
    expect(split).toHaveLength(2)
    // Before the body: the model reads the sender first, exactly as it did when the
    // header was the first line of one part.
    expect(split![0]).toEqual({
      id: 'notice-1',
      role: 'user',
      source: {
        kind: 'plugin:digital-human',
        form: 'notice',
        summary: '来自 pm-assistant · 会话 REQ-1',
      },
      content: [text('<dsh_peer_source from="pm-assistant" session="session-9" conversation="REQ-1" />')],
    })
    // The delivered message keeps its identity: only the content changed.
    expect(split![1]).toMatchObject({ id: 'message-1', role: 'user', content: [text('please review 12345')] })
    expect(split![1].source).toEqual(delivered.source)
  })
})
describe('what counts as a peer source block', () => {
  it('leaves a body that merely mentions the block alone', () => {
    // A peer quoting the convention is prose, not a header. Rewriting it would
    // corrupt the message instead of tidying it.
    const quoted = message([text('the reply carries a <dsh_peer_source ... /> block')])
    expect(splitPeerSourceMessages([quoted])).toBeNull()
  })

  it('never touches the IM channel block', () => {
    // dsh-im splits its own tag in its own hook; recognising it here would take the
    // same text apart twice and leave neither side with a complete message.
    const im = message([text('<dsh_im_source senderId="u1" />'), text('hi')])
    expect(splitPeerSourceMessages([im])).toBeNull()
  })

  it('ignores an assistant message', () => {
    const reply = message([text('<dsh_peer_source from="x" conversation="y" />')], { role: 'assistant' })
    expect(splitPeerSourceMessages([reply])).toBeNull()
  })

  it('does not lift its own notice again', () => {
    // The notice is the block, already folded by the Host. Lifting it would leave an
    // empty user message behind on the next step that sees the same batch.
    const notice = {
      id: 'notice-1',
      role: 'user',
      source: { kind: 'plugin:digital-human', form: 'notice', summary: '来自 x · 会话 y' },
      content: [text('<dsh_peer_source from="x" conversation="y" />')],
    }
    expect(splitPeerSourceMessages([notice])).toBeNull()
  })

  it('splits a block that shares one part with the body', () => {
    // The shape written before the two-part delivery, still sitting in queues and
    // history: one newline is the seam, and the body is what follows it.
    const legacy = message([text('<dsh_peer_source from="pm" conversation="REQ-1" />\nplease review')])
    const split = splitPeerSourceMessages([legacy], { newId: () => 'notice-1' })
    expect(split![1].content).toEqual([text('please review')])
    expect(split![0].content).toEqual([text('<dsh_peer_source from="pm" conversation="REQ-1" />')])
  })

  it('leaves a block with no body behind intact', () => {
    // A message with nothing left is never rewritten: an ugly body beats losing what
    // a peer sent.
    const headerOnly = message([text('<dsh_peer_source from="pm" conversation="REQ-1" />')])
    expect(splitPeerSourceMessages([headerOnly])).toBeNull()
  })

  it('keeps every other message in place and by identity', () => {
    const first = message([text('just words')], { id: 'first' })
    const carried = message([text('<dsh_peer_source from="pm" conversation="c" />'), text('body')], { id: 'second' })
    const split = splitPeerSourceMessages([first, carried], { newId: () => 'notice-1' })
    expect(split!.map((entry: any) => entry.id)).toEqual(['first', 'notice-1', 'second'])
    expect(split![0]).toBe(first)
  })
})
describe('the folded row reads like a sentence', () => {
  const split = (header: string, nameOf?: (id: string) => string | undefined) =>
    splitPeerSourceMessages([message([text(header), text('body')])], { nameOf, newId: () => 'notice-1' })![0].source.summary

  it('names the sender as the registry knows it', () => {
    // The peer id is an address; the name is what a reader recognises.
    expect(split('<dsh_peer_source from="pm-assistant" conversation="REQ-1" />', () => 'PM Assistant'))
      .toBe('来自 PM Assistant · 会话 REQ-1')
  })

  it('falls back to the id the block carries', () => {
    // A sender this host has no record for is named opaquely rather than not at all.
    expect(split('<dsh_peer_source from="stranger" conversation="main" />', () => undefined))
      .toBe('来自 stranger · 会话 main')
  })

  it('drops the thread when the block names none', () => {
    expect(split('<dsh_peer_source from="pm" />')).toBe('来自 pm')
  })

  it('stays within the summary length the Host accepts', () => {
    // An over-long summary is rejected with the whole notice, so the cap is what
    // keeps the lift working for a pathological sender name.
    const summary = split(`<dsh_peer_source from="${'x'.repeat(200)}" conversation="c" />`)
    expect(summary).toHaveLength(120)
  })
})
describe('shapes it must tolerate', () => {
  it('returns null for anything that is not a message list', () => {
    // The batch is handed over by another plugin and is not this module's to trust.
    expect(splitPeerSourceMessages(undefined)).toBeNull()
    expect(splitPeerSourceMessages([{ id: 'm', role: 'user' }])).toBeNull()
    expect(splitPeerSourceMessages([{ id: 'm', role: 'user', content: [{ type: 'image' }] }])).toBeNull()
  })

  it('keeps the row readable when the block names nothing', () => {
    const bare = message([text('<dsh_peer_source />'), text('body')])
    const split = splitPeerSourceMessages([bare], { newId: () => 'notice-1' })
    expect(split![0].source.summary).toBe('来自对等会话')
  })

  it('mints an id of its own when none is injected', () => {
    // The notice is a message the framework will append, so it needs an identity;
    // the delivered message must not be the one that changes.
    const delivered = message([text('<dsh_peer_source from="pm" conversation="c" />'), text('body')])
    const split = splitPeerSourceMessages([delivered])
    expect(split![0].id).toBeTypeOf('string')
    expect(split![0].id).not.toBe('message-1')
    expect(split![1].id).toBe('message-1')
  })
})
