import type { PipelineEvent } from '@openpipeline/core';
import { describe, it, expect } from 'vitest';

import { sseFrame, SSE_HEADERS } from '../src/sse.js';

// `sseFrame` is the wire serializer for Server-Sent Events. Its contract (from
// the docstring + SSE spec) is: `event: <kind>\ndata: <json>\n\n`, where <kind>
// is the event's discriminant and <json> is the JSON encoding of the whole
// event. These tests assert that contract directly rather than snapshotting.

describe('sseFrame', () => {
  it('formats a NODE_START event as `event: <kind>\\ndata: <json>\\n\\n`', () => {
    const event: PipelineEvent = { kind: 'NODE_START', nodeId: 'n1' };
    expect(sseFrame(event)).toBe(
      `event: NODE_START\ndata: {"kind":"NODE_START","nodeId":"n1"}\n\n`
    );
  });

  it('uses the event `kind` as the SSE event name on the first line', () => {
    const event: PipelineEvent = { kind: 'RUN_COMPLETE', status: 'SUCCESS' };
    const firstLine = sseFrame(event).split('\n')[0];
    expect(firstLine).toBe('event: RUN_COMPLETE');
  });

  it('JSON-encodes the *entire* event (not just a payload) on the data line', () => {
    const event: PipelineEvent = { kind: 'LLM_CHUNK', text: 'hello' };
    const frame = sseFrame(event);
    const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
    expect(dataLine).toBeDefined();
    const json = dataLine?.slice('data: '.length) ?? '';
    expect(JSON.parse(json)).toEqual(event);
  });

  it('terminates the frame with a blank line (double newline)', () => {
    const event: PipelineEvent = { kind: 'NODE_END', nodeId: 'n2', output: { ok: true } };
    const frame = sseFrame(event);
    expect(frame.endsWith('\n\n')).toBe(true);
    // Exactly the trailing blank line — not three newlines.
    expect(frame.endsWith('\n\n\n')).toBe(false);
  });

  it('produces exactly two content lines plus the terminating blank', () => {
    const event: PipelineEvent = { kind: 'NODE_START', nodeId: 'n1' };
    // `event:` line, `data:` line, then '' from the trailing \n\n, then '' end.
    expect(sseFrame(event).split('\n')).toEqual([
      'event: NODE_START',
      'data: {"kind":"NODE_START","nodeId":"n1"}',
      '',
      '',
    ]);
  });

  it('escapes embedded newlines via JSON so the data payload stays on one line', () => {
    // A multi-line LLM chunk must not produce extra SSE lines that would split
    // the data field — JSON.stringify turns the "\n" into the literal "\\n".
    const event: PipelineEvent = { kind: 'LLM_CHUNK', text: 'line1\nline2' };
    const frame = sseFrame(event);
    const lines = frame.split('\n');
    // event line, data line, blank, blank — the embedded newline is escaped.
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('data: {"kind":"LLM_CHUNK","text":"line1\\nline2"}');
    const dataJson = lines[1]?.slice('data: '.length) ?? '';
    expect((JSON.parse(dataJson) as { text: string }).text).toBe('line1\nline2');
  });

  it('round-trips an event: parsing the data line reproduces the original', () => {
    const event: PipelineEvent = {
      kind: 'NODE_END',
      nodeId: 'compute',
      output: { value: 42, nested: { deep: [1, 2, 3] } },
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
    };
    const dataJson = sseFrame(event).split('\n')[1]?.slice('data: '.length) ?? '';
    expect(JSON.parse(dataJson)).toEqual(event);
  });
});

describe('SSE_HEADERS', () => {
  it('declares the text/event-stream content type required by the SSE spec', () => {
    expect(SSE_HEADERS['Content-Type']).toBe('text/event-stream');
  });

  it('disables caching and transform so frames are flushed immediately', () => {
    expect(SSE_HEADERS['Cache-Control']).toBe('no-cache, no-transform');
    // X-Accel-Buffering: no tells nginx not to buffer the stream.
    expect(SSE_HEADERS['X-Accel-Buffering']).toBe('no');
  });

  it('keeps the connection alive for the duration of the stream', () => {
    expect(SSE_HEADERS.Connection).toBe('keep-alive');
  });
});
