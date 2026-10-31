const MARKER = '<!-- vahor-preview-status -->';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A successful HTTP response alone is not proof of deployment. The full SHA is.
async function deployed(url, sha, fetcher = fetch, timeoutMs = 10000) {
  try {
    const response = await fetcher(url, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.status === 200 && (await response.json()).sha === sha;
  } catch {
    // DNS, TLS/certificate provisioning, 404s and malformed JSON are retryable.
    return false;
  }
}

async function run({ github, context, core, phase, fetcher = fetch,
  wait = sleep, now = Date.now, timeoutMs = 900000, intervalMs = 15000 }) {
  if (!['building', 'deploying', 'failed'].includes(phase)) {
    throw new Error(`Unknown preview phase: ${phase}`);
  }
  const pull = context.payload.pull_request;
  if (!pull || pull.head.repo.full_name !== `${context.repo.owner}/${context.repo.repo}`) {
    core.info('No preview side effects for forks or non-PR events.');
    return;
  }
  const sha = pull.head.sha;
  const args = { ...context.repo, issue_number: pull.number };
  const url = `https://vahor-fr-${pull.number}.preview.vahor.fr`;
  const runUrl = `${context.serverUrl || 'https://github.com'}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  async function current() {
    const { data } = await github.rest.pulls.get({ ...context.repo, pull_number: pull.number });
    const valid = data.state === 'open' && data.head.sha === sha;
    if (!valid) core.info('Skipping closed or superseded PR; leaving status untouched.');
    return valid;
  }
  async function comment(state) {
    // Paginate so old sticky comments are still found on busy PRs. Only ever
    // edit our bot's marker, never a user-authored copy of it.
    const comments = await github.paginate(github.rest.issues.listComments, args);
    const existing = comments.find((item) => item.user?.type === 'Bot'
      && item.user.login === 'github-actions[bot]' && item.body?.includes(MARKER));
    if (!await current()) return false;
    const body = `${MARKER}\n## Preview deployment\n\n${state}\n\nCommit: \`${sha}\` · [Build logs](${runUrl})`;
    if (existing) {
      await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
    } else {
      await github.rest.issues.createComment({ ...args, body });
    }
    return true;
  }
  if (phase === 'building') return comment('⏳ **Building**');
  if (phase === 'failed') return comment('❌ **Build failed** — preview was not verified for this commit. See build logs.');
  try {
    if (!await current()) return;
    await github.rest.issues.addLabels({ ...args, labels: ['preview-ready'] });
    if (!await comment('⏳ **Deploying / Waiting** — image published; waiting for the public deployment to serve this commit.')) return;
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (!await current()) return;
      // Bypass intermediary caches as well as the browser-style fetch cache.
      const endpoint = `${url}/deployment.json?sha=${sha}&probe=${now()}`;
      if (await deployed(endpoint, sha, fetcher, Math.min(10000, Math.max(1, deadline - now())))) {
        await comment(`✅ **Ready** — [Open preview](${url})`);
        return;
      }
      await wait(Math.min(intervalMs, Math.max(0, deadline - now())));
    }
    if (await comment('❌ **Deployment timed out** — the public endpoint did not confirm this commit within 15 minutes. See build logs.')) {
      core.setFailed('Preview readiness timed out: deployment.json did not return the expected full head SHA.');
    }
  } catch (error) {
    // Do not include arbitrary remote error text in the public comment.
    await comment('❌ **Deployment failed** — readiness could not be verified. See build logs.');
    throw error;
  }
}

module.exports = { MARKER, deployed, run };
