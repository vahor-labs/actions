const MARKER = '<!-- vahor-preview-status -->';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Infrastructure must route this commit-specific URL only to full-SHA pods.
async function deployed(url, fetcher, timeoutMs, core) {
  try {
    const response = await fetcher(url, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      core.info(`HTTP ${response.status}; preview is not ready.`);
      return false;
    }
    core.info('HTTP 200 from the commit-specific preview route.');
    return true;
  } catch (error) {
    // DNS, TLS/certificate provisioning, redirects and timeouts are retryable.
    core.info(`Probe failed (${error.cause?.code || error.name}); retrying.`);
    return false;
  }
}

async function run({ github, context, core, phase, previewPrefix = '', fetcher = fetch,
  wait = sleep, now = Date.now, timeoutMs = 900000, intervalMs = 5000 }) {
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
  const prefix = previewPrefix || context.repo.repo.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 46).replace(/-+$/g, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,44}[a-z0-9])?$/.test(prefix)) {
    throw new Error('preview-prefix must be a lowercase DNS label of at most 46 characters.');
  }
  const url = new URL(`https://${prefix}-pr-${pull.number}.preview.vahor.fr/`);
  const endpoint = new URL(`https://${prefix}-sha-${sha.slice(0, 12)}.preview.vahor.fr/`);
  const repoUrl = `${context.serverUrl || 'https://github.com'}/${context.repo.owner}/${context.repo.repo}`;
  const runUrl = `${repoUrl}/actions/runs/${context.runId}`;
  async function current() {
    const { data } = await github.rest.pulls.get({ ...context.repo, pull_number: pull.number });
    const valid = data.state === 'open' && data.head.sha === sha;
    if (!valid) core.info('Skipping closed or superseded PR; leaving status untouched.');
    return valid;
  }
  async function comment(state, ready = false) {
    // Paginate so old sticky comments are still found on busy PRs. Only ever
    // edit our bot's marker, never a user-authored copy of it.
    const comments = await github.paginate(github.rest.issues.listComments, args);
    const existing = comments.find((item) => item.user?.type === 'Bot'
      && item.user.login === 'github-actions[bot]' && item.body?.includes(MARKER));
    if (!await current()) return false;
    const keepPrLink = ['⏳ Building', '⏳ Deploying'].includes(state)
      && existing?.body.includes(`](${url})`);
    const links = ready
      ? ` · [PR preview](${url}) · [Commit preview](${endpoint})`
      : keepPrLink ? ` · [PR preview](${url})` : '';
    const updated = new Date(now()).toISOString();
    const body = `${MARKER}\n`
      + '| Deployment | Actions | Updated |\n'
      + '| :--- | :--- | :--- |\n'
      + `| ${state}${links} | [Logs](${runUrl}) · [\`${sha.slice(0, 7)}\`](${repoUrl}/commit/${sha}) | <relative-time datetime="${updated}">${updated}</relative-time> |`;
    if (existing) {
      await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
    } else {
      await github.rest.issues.createComment({ ...args, body });
    }
    return true;
  }
  if (phase === 'building') return comment('⏳ Building');
  if (phase === 'failed') return comment('❌ Build failed');
  try {
    if (!await current()) return;
    await github.rest.issues.addLabels({ ...args, labels: ['preview-ready'] });
    if (!await comment('⏳ Deploying')) return;
    const started = now();
    const deadline = started + timeoutMs;
    let attempt = 0;
    core.info(`Waiting for commit route ${endpoint} for ${sha}. Polling every ${intervalMs / 1000}s for up to ${timeoutMs / 60000} minutes.`);
    while (now() < deadline) {
      if (!await current()) return;
      core.info(`Attempt ${++attempt} (${Math.round((now() - started) / 1000)}s elapsed): ${endpoint}`);
      if (await deployed(endpoint, fetcher, Math.min(10000, Math.max(1, deadline - now())), core)) {
        if (await comment('✅ Ready', true)) {
          core.info(`Verified HTTP 200 on commit route ${endpoint} for current commit ${sha} after ${Math.round((now() - started) / 1000)}s; full-SHA isolation is enforced by infrastructure.`);
        }
        return;
      }
      await wait(Math.min(intervalMs, Math.max(0, deadline - now())));
    }
    if (await comment('❌ Deployment timed out')) {
      core.setFailed('Preview readiness timed out: commit-specific preview URL did not return HTTP 200.');
    }
  } catch (error) {
    // Do not include arbitrary remote error text in the public comment.
    await comment('❌ Deployment failed');
    throw error;
  }
}

module.exports = { run };
