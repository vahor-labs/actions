const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { MARKER, deployed, run } = require('./status.cjs');

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function fixture() {
  const comments = [{ id: 1, user: { type: 'User', login: 'author' }, body: MARKER }];
  const writes = [];
  const failures = [];
  let clock = 0;
  const pull = { state: 'open', number: 42, head: { sha: SHA, repo: { full_name: 'vahor-labs/vahor.fr' } } };
  const options = {
    context: { repo: { owner: 'vahor-labs', repo: 'vahor.fr' }, runId: 123,
      payload: { pull_request: structuredClone(pull) } },
    core: { info() {}, setFailed: (message) => failures.push(message) },
    github: {
      paginate: async () => comments,
      rest: {
        pulls: { get: async () => ({ data: pull }) },
        issues: {
          listComments() {},
          createComment: async (args) => {
            writes.push({ type: 'create', ...args });
            comments.push({ id: 2, user: { type: 'Bot', login: 'github-actions[bot]' }, body: args.body });
          },
          updateComment: async (args) => {
            writes.push({ type: 'update', ...args });
            comments.find((comment) => comment.id === args.comment_id).body = args.body;
          },
          addLabels: async (args) => writes.push({ type: 'label', ...args }),
        },
      },
    },
    now: () => clock,
    wait: async (ms) => { clock += ms; },
    timeoutMs: 45,
    intervalMs: 15,
  };
  return { options, pull, comments, writes, failures };
}

test('real HTTP: 200 old/missing/short SHA, invalid JSON, redirects and 404 are not ready', async (t) => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers['cache-control'], 'no-cache');
    res.setHeader('Cache-Control', 'no-store');
    const routes = {
      '/ready': [200, JSON.stringify({ sha: SHA })],
      '/old': [200, JSON.stringify({ sha: OTHER })],
      '/short': [200, JSON.stringify({ sha: SHA.slice(0, 7) })],
      '/missing': [200, '{}'],
      '/invalid': [200, '<html>not JSON</html>'],
      '/404': [404, JSON.stringify({ sha: SHA })],
      '/redirect': [302, ''],
    };
    const [status, body] = routes[req.url];
    if (status === 302) res.setHeader('Location', '/ready');
    res.writeHead(status).end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['old', 'short', 'missing', 'invalid', '404', 'redirect']) {
    assert.equal(await deployed(`${base}/${route}`, SHA), false, route);
  }
  assert.equal(await deployed(`${base}/ready`, SHA), true);
});

test('network/TLS errors and fetch timeout are retryable', async () => {
  assert.equal(await deployed('https://unused', SHA, async () => { throw new Error('certificate pending'); }), false);
  assert.equal(await deployed('https://unused', SHA, async (_url, { signal }) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); });
    });
  }, 5), false);
});

test('one bot sticky comment goes Building -> Waiting -> Ready, never edits user marker', async () => {
  const f = fixture();
  await run({ ...f.options, phase: 'building' });
  assert.match(f.comments[1].body, /Building/);
  assert.doesNotMatch(f.comments[1].body, /https:\/\/vahor-fr-/);
  let probes = 0;
  await run({ ...f.options, phase: 'deploying', fetcher: async (url) => {
    assert.match(url, /^https:\/\/vahor-fr-42\.preview\.vahor\.fr\/deployment\.json\?sha=/);
    const body = f.comments[1].body;
    assert.match(body, /Deploying \/ Waiting/);
    assert.doesNotMatch(body, /Open preview/);
    return new Response(JSON.stringify({ sha: ++probes === 1 ? OTHER : SHA }));
  } });
  assert.equal(probes, 2);
  assert.equal(f.comments.length, 2);
  assert.equal(f.comments[0].body, MARKER);
  assert.match(f.comments[1].body, /Ready.*https:\/\/vahor-fr-42.preview.vahor.fr/);
  assert.equal(f.writes.filter((w) => w.type === 'create').length, 1);
  assert.deepEqual(f.writes.filter((w) => w.type === 'label')[0].labels, ['preview-ready']);
  assert.deepEqual(f.failures, []);
  // Re-running starts over on the same comment, removing the old preview link.
  await run({ ...f.options, phase: 'building' });
  assert.equal(f.comments.length, 2);
  assert.doesNotMatch(f.comments[1].body, /Open preview/);
});

test('wrong SHA times out honestly, no preview URL', async () => {
  const f = fixture();
  await run({ ...f.options, phase: 'deploying', fetcher: async () => new Response(JSON.stringify({ sha: OTHER })) });
  assert.match(f.comments[1].body, /Deployment timed out/);
  assert.doesNotMatch(f.comments[1].body, /Open preview/);
  assert.equal(f.failures.length, 1);
});

test('build failure updates existing comment without labeling or polling', async () => {
  const f = fixture();
  await run({ ...f.options, phase: 'building' });
  await run({ ...f.options, phase: 'failed', fetcher: () => assert.fail('must not poll') });
  assert.match(f.comments[1].body, /Build failed/);
  assert.equal(f.writes.filter((w) => w.type === 'label').length, 0);
  assert.equal(f.comments.length, 2);
});

test('closed, superseded, and fork PRs do not write', async () => {
  for (const kind of ['closed', 'superseded', 'fork']) {
    for (const phase of ['building', 'deploying', 'failed']) {
      const f = fixture();
      if (kind === 'closed') f.pull.state = 'closed';
      if (kind === 'superseded') f.pull.head.sha = OTHER;
      if (kind === 'fork') f.options.context.payload.pull_request.head.repo.full_name = 'fork/vahor.fr';
      await run({ ...f.options, phase, fetcher: () => assert.fail('must not poll') });
      assert.deepEqual(f.writes, [], `${kind} ${phase}`);
    }
  }
});

test('head changes during a matching probe: cannot overwrite newer status with Ready', async () => {
  const f = fixture();
  await run({ ...f.options, phase: 'deploying', fetcher: async () => {
    f.pull.head.sha = OTHER;
    return new Response(JSON.stringify({ sha: SHA }));
  } });
  assert.doesNotMatch(f.comments[1].body, /\*\*Ready\*\*/);
  assert.equal(f.writes.filter((w) => w.body).length, 1);
});

test('head changes while listing comments: no stale write', async () => {
  const f = fixture();
  f.options.github.paginate = async () => { f.pull.head.sha = OTHER; return f.comments; };
  await run({ ...f.options, phase: 'building' });
  assert.deepEqual(f.writes, []);
});

test('PR closes while waiting: skip instead of reporting timeout/failure', async () => {
  const f = fixture();
  await run({ ...f.options, phase: 'deploying', fetcher: async () => {
    f.pull.state = 'closed';
    return new Response('{}');
  } });
  assert.deepEqual(f.failures, []);
  assert.equal(f.writes.filter((w) => w.body).length, 1);
});

test('label/API failure gives a failure status and propagates failure', async () => {
  const f = fixture();
  f.options.github.rest.issues.addLabels = async () => { throw new Error('API unavailable'); };
  await assert.rejects(run({ ...f.options, phase: 'deploying' }), /API unavailable/);
  assert.match(f.comments[1].body, /Deployment failed/);
  assert.doesNotMatch(f.comments[1].body, /Open preview/);
});
