import assert from 'node:assert/strict';
import test from 'node:test';
import { readChatStream, STREAM_CHAT_ABOVE_TOKENS, VeniceClient } from '../dist/venice/client.js';

function sse(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function event(delta) {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
}

function stubFetch(responses) {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next();
  };
  return { bodies, restore: () => { globalThis.fetch = original; } };
}

test('a streamed answer is its content deltas, with reasoning skipped, across split chunks', async () => {
  const whole = [
    event({ reasoning_content: 'Thinking about the film...' }),
    event({ content: '{"logline": "A jour' }),
    event({ content: 'nalist crosses."}' }),
    'data: [DONE]\n\n',
  ].join('');
  // Cut the bytes at awkward places: mid-line and mid-JSON.
  const chunks = [whole.slice(0, 17), whole.slice(17, 90), whole.slice(90, 91), whole.slice(91)];
  assert.equal(await readChatStream(sse(chunks)), '{"logline": "A journalist crosses."}');
});

test('an error event in the stream throws with its message', async () => {
  const chunks = [event({ content: '{"a":' }), `data: ${JSON.stringify({ error: { message: 'context length exceeded' } })}\n\n`];
  await assert.rejects(readChatStream(sse(chunks)), /context length exceeded/);
});

test('chatJson streams a long generation and parses its JSON', async () => {
  const stub = stubFetch([
    () => new Response(sse([event({ reasoning_content: '...' }), event({ content: '```json\n{"shots": 64}\n```' }), 'data: [DONE]\n\n']), { status: 200 }),
  ]);
  try {
    const client = new VeniceClient('test-key');
    const answer = await client.chatJson({ model: 'kimi-k3', systemPrompt: 's', userPrompt: 'u', maxTokens: STREAM_CHAT_ABOVE_TOKENS + 1, label: 'workshop' });
    assert.deepEqual(answer, { shots: 64 });
    assert.equal(stub.bodies[0].stream, true);
    assert.equal(stub.bodies[0].max_tokens, STREAM_CHAT_ABOVE_TOKENS + 1);
  } finally {
    stub.restore();
  }
});

test('chatJson keeps a short generation unstreamed', async () => {
  const stub = stubFetch([
    () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok": true}' } }] }), { status: 200 }),
  ]);
  try {
    const client = new VeniceClient('test-key');
    const answer = await client.chatJson({ model: 'kimi-k3', systemPrompt: 's', userPrompt: 'u', maxTokens: 8000 });
    assert.deepEqual(answer, { ok: true });
    assert.equal(stub.bodies[0].stream, undefined);
  } finally {
    stub.restore();
  }
});

test('a stream that fails before it starts is retried; a 4xx is not', async () => {
  const stub = stubFetch([
    () => new Response(JSON.stringify({ error: 'busy' }), { status: 503 }),
    () => new Response(sse([event({ content: 'done' }), 'data: [DONE]\n\n']), { status: 200 }),
  ]);
  try {
    const client = new VeniceClient('test-key');
    assert.equal(await client.postChatStream({ model: 'kimi-k3', messages: [] }), 'done');
    assert.equal(stub.bodies.length, 2);
  } finally {
    stub.restore();
  }
  const bad = stubFetch([() => new Response(JSON.stringify({ error: 'Specified model not found' }), { status: 404 })]);
  try {
    const client = new VeniceClient('test-key');
    await assert.rejects(client.postChatStream({ model: 'nope', messages: [] }), /Specified model not found/);
    assert.equal(bad.bodies.length, 1);
  } finally {
    bad.restore();
  }
});
