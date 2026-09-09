import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, claudePrintArgs, parsePrintEnvelope, promptTokens, resolveEffort, resolveModel, takeUsage } from './ai.js';

const envelope = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    terminal_reason: 'completed',
    duration_ms: 1834,
    result: '{"summary":"LGTM","comments":[]}',
    total_cost_usd: 0.072033,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 6592,
      cache_read_input_tokens: 10078,
      output_tokens: 4,
    },
    modelUsage: { 'claude-haiku-4-5-20251001': {}, 'claude-fable-5-1': {} },
    ...over,
  });

test('parsePrintEnvelope returns the model text and the measured usage', () => {
  const { text, usage } = parsePrintEnvelope(envelope());
  assert.equal(text, '{"summary":"LGTM","comments":[]}');
  assert.ok(usage);
  assert.equal(usage.inputTokens, 2);
  assert.equal(usage.cacheCreationTokens, 6592);
  assert.equal(usage.cacheReadTokens, 10078);
  assert.equal(usage.outputTokens, 4);
  assert.equal(usage.costUsd, 0.072033);
  assert.equal(usage.durationMs, 1834);
  assert.deepEqual(usage.models, ['claude-haiku-4-5-20251001', 'claude-fable-5-1']);
  assert.equal(usage.measured, true);
  assert.equal(promptTokens(usage), 2 + 6592 + 10078);
});

test('parsePrintEnvelope passes non-envelope output through unmeasured', () => {
  const raw = '{"summary":"a bare review object","comments":[]}';
  const { text, usage } = parsePrintEnvelope(raw);
  assert.equal(text, raw);
  assert.equal(usage, null);

  const plain = 'not json at all';
  assert.deepEqual(parsePrintEnvelope(plain), { text: plain, usage: null });
});

test('parsePrintEnvelope throws on a failed run with nothing to parse', () => {
  assert.throws(
    () => parsePrintEnvelope(envelope({ result: '', is_error: true, terminal_reason: 'api_error' })),
    /did not complete: api_error/
  );
});

test('parsePrintEnvelope keeps a JSON-bearing result that arrived with an error flag', () => {
  // A partial-but-present result is worth more than an exception: the caller's
  // JSON repair may still salvage findings from it.
  const { text } = parsePrintEnvelope(envelope({ is_error: true, result: '{"summary":"partial"' }));
  assert.equal(text, '{"summary":"partial"');
});

test('parsePrintEnvelope surfaces a plain-text failure message instead of returning it as output', () => {
  assert.throws(
    () => parsePrintEnvelope(envelope({ is_error: true, result: 'Not logged in · Please run /login' })),
    /did not complete: Not logged in/
  );
});

test('parsePrintEnvelope surfaces an API error whose body carries inline JSON', () => {
  assert.throws(
    () => parsePrintEnvelope(envelope({ is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' })),
    /did not complete: API Error: 529/
  );
});

test('parsePrintEnvelope marks an envelope without a usage block as unmeasured, not $0', () => {
  const { usage } = parsePrintEnvelope(JSON.stringify({ result: 'ok' }));
  assert.ok(usage);
  assert.equal(usage.measured, false);
  assert.equal(promptTokens(usage), 0);
  assert.deepEqual(usage.models, []);
});

test('routingSettings names only the settings that route or authenticate', async () => {
  const { routingSettings } = await import('./ai.js');
  assert.deepEqual(routingSettings(null), []);
  assert.deepEqual(routingSettings({ model: 'x', hooks: {}, env: { CLAUDE_CODE_ENABLE_TELEMETRY: '0', EDITOR: 'vim' } }), []);
  assert.deepEqual(
    routingSettings({ apiKeyHelper: '/bin/key', env: { ANTHROPIC_BASE_URL: 'https://proxy', HTTPS_PROXY: 'x', FOO: 'y' } }),
    ['apiKeyHelper', 'env.ANTHROPIC_BASE_URL', 'env.HTTPS_PROXY']
  );
});

test('claudePrintArgs is a real argv: empty setting-sources, model and effort pinned when known', () => {
  const args = claudePrintArgs('claude-fable-5-1[1m]', 'high', '');
  assert.ok(args.includes('--print'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-fable-5-1[1m]');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');

  const bare = claudePrintArgs(undefined, undefined, 'user');
  assert.ok(!bare.includes('--model'));
  assert.ok(!bare.includes('--effort'));
  assert.equal(bare[bare.indexOf('--setting-sources') + 1], 'user');
});

test('resolveModel prefers LGTM_MODEL, then the operator settings, and rejects junk', () => {
  const settings = { model: 'claude-fable-5-1[1m]' };
  const saved = process.env.LGTM_MODEL;
  try {
    delete process.env.LGTM_MODEL;
    assert.equal(resolveModel(settings), 'claude-fable-5-1[1m]');
    assert.equal(resolveModel(null), undefined);
    assert.equal(resolveModel({ model: 42 }), undefined);
    assert.equal(resolveModel({ model: 'claude-sonnet-5@20260501' }), 'claude-sonnet-5@20260501', 'Vertex form passes');
    assert.equal(resolveModel({ model: 'arn:aws:bedrock:eu-west-1:1:inference-profile/eu.anthropic.claude-opus-5' }), 'arn:aws:bedrock:eu-west-1:1:inference-profile/eu.anthropic.claude-opus-5', 'Bedrock ARN passes');
    assert.equal(resolveModel({ model: 'has space' }), undefined, 'unpassable id is dropped, with a warning');

    process.env.LGTM_MODEL = 'claude-sonnet-5';
    assert.equal(resolveModel(settings), 'claude-sonnet-5');

    process.env.LGTM_MODEL = 'not a model; rm -rf';
    assert.equal(resolveModel(settings), 'claude-fable-5-1[1m]', 'junk env falls through to settings');
  } finally {
    if (saved === undefined) delete process.env.LGTM_MODEL; else process.env.LGTM_MODEL = saved;
  }
});

test('resolveEffort follows the CLI precedence: env, per-model override, global', () => {
  const settings = { effortLevel: 'xhigh', modelSettings: { 'claude-fable-5-1': { effortLevel: 'high' } } };
  const saved = process.env.LGTM_EFFORT;
  try {
    delete process.env.LGTM_EFFORT;
    assert.equal(resolveEffort('claude-fable-5-1[1m]', settings), 'high', 'suffix stripped for the per-model lookup');
    assert.equal(resolveEffort('claude-opus-5', settings), 'xhigh', 'no per-model entry ⇒ global');
    assert.equal(resolveEffort(undefined, settings), 'xhigh');
    assert.equal(resolveEffort('claude-opus-5', { effortLevel: 'extreme' }), undefined, 'unknown level ignored');
    assert.equal(resolveEffort('claude-opus-5', null), undefined);

    process.env.LGTM_EFFORT = 'low';
    assert.equal(resolveEffort('claude-fable-5-1[1m]', settings), 'low');
  } finally {
    if (saved === undefined) delete process.env.LGTM_EFFORT; else process.env.LGTM_EFFORT = saved;
  }
});

test('the ledger sums measured calls and is tainted by any unmeasured one', () => {
  takeUsage(); // start clean
  const { usage: a } = parsePrintEnvelope(envelope());
  addUsage(a);
  addUsage(a);
  let window = takeUsage();
  assert.equal(window.calls, 2);
  assert.equal(window.measured, true);
  assert.equal(promptTokens(window), 2 * (2 + 6592 + 10078));
  assert.equal(window.outputTokens, 8);
  assert.deepEqual(window.models, ['claude-haiku-4-5-20251001', 'claude-fable-5-1']);

  addUsage(a);
  addUsage(parsePrintEnvelope(JSON.stringify({ result: 'ok' })).usage); // envelope, no usage block
  window = takeUsage();
  assert.equal(window.calls, 2);
  assert.equal(window.measured, false, 'a usage-less envelope must not read as a $0 measurement');

  addUsage(a);
  addUsage(null); // codex
  window = takeUsage();
  assert.equal(window.measured, false);

  assert.equal(takeUsage().calls, 0, 'take resets');
});
