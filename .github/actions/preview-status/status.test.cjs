const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./status.cjs');

const SHA = 'a1b2c3d4e5f67890123456789012345678901234';
const MARKER = '<!-- vahor-preview-status -->';
const STABLE = 'https://my-app-pr-42.preview.example.com/';
const TEMPLATE = 'https://my-app-sha-{sha}.preview.example.com/';

function fixture(overrides = {}) {
  const calls = { comments: [], labels: [], probes: [], logs: [], failures: [], waits: [] };
  let clock = 0;
  let live = { state: 'open', head: { sha: SHA } };
  const comments = [];
  const github = {
    paginate: async () => comments,
    rest: {
      pulls: { get: async () => ({ data: live }) },
      issues: {
        listComments() {},
        addLabels: async (args) => calls.labels.push(args),
        createComment: async (args) => calls.comments.push({ method: 'create', ...args }),
        updateComment: async (args) => calls.comments.push({ method: 'update', ...args }),
      },
    },
  };
  const options = {
    github,
    context: {
      repo: { owner: 'example', repo: 'my-app' }, runId: 123,
      payload: { pull_request: {
        number: 42, head: { sha: SHA, repo: { full_name: 'example/my-app' } },
      } },
    },
    core: {
      info: (message) => calls.logs.push(message),
      setFailed: (message) => calls.failures.push(message),
    },
    phase: 'deploying', previewUrl: STABLE, previewCheckUrl: TEMPLATE,
    timeoutMs: 100, intervalMs: 15,
    now: () => clock,
    wait: async (ms) => { calls.waits.push(ms); clock += ms; },
    fetcher: async (url, init) => {
      calls.probes.push({ url: String(url), init });
      // A normal page is enough: there is deliberately no JSON method.
      return { status: 200 };
    },
    ...overrides,
  };
  return { options, calls, comments, setLive: (value) => { live = value; } };
}

test('probes the rendered commit URL itself and links only the stable URL', async () => {
  const f = fixture({
    previewCheckUrl: `${TEMPLATE}health/{sha}?revision={sha}`,
  });
  await run(f.options);
  assert.equal(f.calls.probes.length, 1);
  const { url, init } = f.calls.probes[0];
  assert.equal(url, 'https://my-app-sha-a1b2c3d4e5f6.preview.example.com/health/a1b2c3d4e5f6?revision=a1b2c3d4e5f6');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.headers['Cache-Control'], 'no-cache');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.match(f.calls.comments.at(-1).body, /✅ \[Ready\]\(https:\/\/my-app-pr-42.preview.example.com\/\)/);
  assert.ok(!f.calls.comments.at(-1).body.includes('my-app-sha-'));
  assert.deepEqual(f.calls.failures, []);
  assert.ok(f.calls.logs.some((line) => line.includes('Verified HTTP 200 on commit route')
    && line.includes(SHA) && line.includes('infrastructure')));
});

test('retries non-200s, DNS/TLS failures, redirects and aborts before success', async () => {
  const f = fixture();
  const outcomes = [404, 503, 302,
    Object.assign(new Error(), { cause: { code: 'ENOTFOUND' } }),
    Object.assign(new Error(), { cause: { code: 'CERT_HAS_EXPIRED' } }),
    new TypeError('redirect'), new DOMException('timeout', 'TimeoutError'), 200];
  f.options.timeoutMs = 200;
  f.options.fetcher = async (_url, init) => {
    assert.equal(init.redirect, 'error');
    const result = outcomes.shift();
    if (result instanceof Error) throw result;
    return { status: result };
  };
  await run(f.options);
  assert.equal(outcomes.length, 0);
  assert.equal(f.calls.waits.length, 7);
  assert.match(f.calls.comments.at(-1).body, /✅ \[Ready\]/);
  assert.deepEqual(f.calls.failures, []);
});

test('bounds each probe to 10 seconds or the remaining deadline', async (t) => {
  const budgets = [];
  const original = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    budgets.push(ms);
    return original(ms);
  });
  const f = fixture({ timeoutMs: 25000, intervalMs: 15000 });
  f.options.fetcher = async () => ({ status: 503 });
  await run(f.options);
  assert.deepEqual(budgets, [10000, 10000]);
  assert.deepEqual(f.calls.waits, [15000, 10000]);
  assert.match(f.calls.comments.at(-1).body, /❌ Deployment timed out/);
  assert.equal(f.calls.failures.length, 1);
  assert.match(f.calls.failures[0], /commit-specific preview URL/);

  const short = fixture({ timeoutMs: 7 });
  short.options.fetcher = async () => ({ status: 404 });
  await run(short.options);
  assert.equal(budgets.at(-1), 7);
  assert.deepEqual(short.calls.waits, [7]);
});

test('a stalled fetch is aborted and ends in timeout without a Ready link', async () => {
  const f = fixture({ timeoutMs: 25, intervalMs: 1, now: Date.now });
  let aborted = false;
  f.options.fetcher = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      aborted = true;
      reject(signal.reason);
    }, { once: true });
  });
  // AbortSignal.timeout uses an unref'ed timer; keep the test process alive.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await run(f.options);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(aborted, true);
  assert.equal(f.calls.failures.length, 1);
  assert.ok(f.calls.comments.every(({ body }) => !body.includes('[Ready]')));
});

test('both URLs require HTTPS and the check URL requires its SHA placeholder', async () => {
  for (const overrides of [
    { previewUrl: 'http://stable.example.com' },
    { previewCheckUrl: 'http://sha-{sha}.example.com' },
    { previewCheckUrl: 'https://stable.example.com' },
    { previewCheckUrl: undefined },
  ]) {
    const f = fixture(overrides);
    await assert.rejects(run(f.options), /HTTPS|contain \{sha\}/);
    assert.equal(f.calls.comments.length, 0);
    assert.equal(f.calls.labels.length, 0);
    assert.equal(f.calls.probes.length, 0);
  }
});

test('forks and non-PR events have no API or network side effects', async () => {
  for (const fork of [true, false]) {
    const f = fixture({ previewUrl: undefined, previewCheckUrl: undefined });
    if (fork) f.options.context.payload.pull_request.head.repo.full_name = 'fork/my-app';
    else f.options.context.payload = {};
    f.options.github = new Proxy({}, { get() { assert.fail('unexpected GitHub API access'); } });
    await run(f.options);
    assert.equal(f.calls.probes.length, 0);
    assert.equal(f.calls.failures.length, 0);
  }
});

test('closed or superseded PRs are untouched before deployment', async () => {
  for (const live of [
    { state: 'closed', head: { sha: SHA } },
    { state: 'open', head: { sha: 'other' } },
  ]) {
    const f = fixture();
    f.setLive(live);
    await run(f.options);
    assert.equal(f.calls.labels.length, 0);
    assert.equal(f.calls.comments.length, 0);
    assert.equal(f.calls.probes.length, 0);
  }
});

test('supersession during a successful probe cannot publish Ready', async () => {
  const f = fixture();
  f.options.fetcher = async () => {
    f.setLive({ state: 'open', head: { sha: 'new-head' } });
    return { status: 200 };
  };
  await run(f.options);
  assert.equal(f.calls.comments.length, 1);
  assert.match(f.calls.comments[0].body, /Deploying/);
  assert.ok(!f.calls.logs.some((line) => line.startsWith('Verified')));
  assert.deepEqual(f.calls.failures, []);
});

test('supersession at the deadline does not publish a timeout or fail the run', async () => {
  const f = fixture({ timeoutMs: 5 });
  f.options.fetcher = async () => {
    f.setLive({ state: 'open', head: { sha: 'new-head' } });
    return { status: 404 };
  };
  await run(f.options);
  assert.equal(f.calls.comments.length, 1);
  assert.deepEqual(f.calls.failures, []);
});

test('building and failed phases edit only the sticky actions bot comment', async () => {
  for (const [phase, state] of [['building', '⏳ Building'], ['failed', '❌ Build failed']]) {
    const f = fixture({ phase });
    f.comments.push(
      { id: 1, user: { type: 'User', login: 'github-actions[bot]' }, body: MARKER },
      { id: 2, user: { type: 'Bot', login: 'other[bot]' }, body: MARKER },
      { id: 3, user: { type: 'Bot', login: 'github-actions[bot]' }, body: MARKER },
    );
    await run(f.options);
    assert.equal(f.calls.comments.length, 1);
    assert.equal(f.calls.comments[0].method, 'update');
    assert.equal(f.calls.comments[0].comment_id, 3);
    assert.ok(f.calls.comments[0].body.includes(state));
    assert.equal(f.calls.labels.length, 0);
    assert.equal(f.calls.probes.length, 0);
  }
});
