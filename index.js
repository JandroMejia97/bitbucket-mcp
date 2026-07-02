import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Load .env from the script's own directory, regardless of where Cursor launches it from
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '.env') });

const { BITBUCKET_EMAIL, BITBUCKET_API_TOKEN } = process.env;
if (!BITBUCKET_EMAIL || !BITBUCKET_API_TOKEN) {
  throw new Error('Missing BITBUCKET_EMAIL or BITBUCKET_API_TOKEN in .env');
}

const auth = 'Basic ' + Buffer.from(`${BITBUCKET_EMAIL}:${BITBUCKET_API_TOKEN}`).toString('base64');

// ── HTTP helpers ───────────────────────────────────────────────────────────

function buildHeaders(hasBody) {
  const headers = { Authorization: auth };
  if (hasBody) headers['Content-Type'] = 'application/json';
  return headers;
}

async function parseResponse(res) {
  const text = await res.text();
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: null, text };
  }
}

function toError(status, data, text) {
  if (status === 400 && (!text || text.trim() === 'Bad Request')) {
    return new Error('HTTP 400: Bad Request. Note — you cannot approve or request changes on a PR you authored.');
  }
  return new Error(data?.error?.message ?? text ?? `HTTP ${status}`);
}

async function bbRequest(method, path, body) {
  const res = await fetch(`https://api.bitbucket.org/2.0${path}`, {
    method,
    headers: buildHeaders(!!body),
    body: body ? JSON.stringify(body) : undefined,
  });
  const { data, text } = await parseResponse(res);
  if (!res.ok) throw toError(res.status, data, text);
  return data;
}

async function bbRequestRaw(method, path, body) {
  const res = await fetch(`https://api.bitbucket.org/2.0${path}`, {
    method,
    headers: buildHeaders(!!body),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const { data, text } = await parseResponse(res);
  if (!res.ok) throw toError(res.status, data, text);
  return data;
}

// ── Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'bitbucket-pr-comments', version: '1.0.0' });

// ── 1. Create a single comment ─────────────────────────────────────────────
server.registerTool(
  'add_pr_comment',
  {
    description: 'Creates a comment on a Pull Request. Can be a general comment or an inline comment on a specific line of code.',
    inputSchema: {
      workspace: z.string().describe('Bitbucket workspace slug'),
      repo:      z.string().describe('Repository slug'),
      pr_id:     z.number().int().positive().describe('Pull Request ID'),
      content:   z.string().min(1).describe('Comment content (markdown supported)'),
      file_path: z.string().optional().describe('File path for an inline comment'),
      line:      z.number().int().positive().optional().describe('Line number for an inline comment (requires file_path)'),
    },
  },
  async ({ workspace, repo, pr_id, content, file_path, line }) => {
    const body = { content: { raw: content } };
    if (file_path && line) body.inline = { path: file_path, to: line };
    const data = await bbRequest('POST', `/repositories/${workspace}/${repo}/pullrequests/${pr_id}/comments`, body);
    const type = file_path ? `inline at ${file_path}:${line}` : 'general';
    return { content: [{ type: 'text', text: `✓ Comment #${data.id} created (${type}).` }] };
  }
);

// ── 2. Create N comments in bulk ───────────────────────────────────────────
server.registerTool(
  'add_pr_comments_bulk',
  {
    description: 'Creates multiple comments on a Pull Request in a single call.',
    inputSchema: {
      workspace: z.string().describe('Bitbucket workspace slug'),
      repo:      z.string().describe('Repository slug'),
      pr_id:     z.number().int().positive().describe('Pull Request ID'),
      comments:  z.array(z.object({
        content:   z.string().min(1).describe('Comment content'),
        file_path: z.string().optional().describe('File path for an inline comment'),
        line:      z.number().int().positive().optional().describe('Line number for an inline comment'),
      })).min(1).describe('List of comments to create'),
      delay_ms: z.number().int().min(0).max(5000).optional().default(300).describe('Delay between requests in ms (default 300)'),
    },
  },
  async ({ workspace, repo, pr_id, comments, delay_ms }) => {
    const results = [];
    const errors = [];
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i];
      try {
        const body = { content: { raw: c.content } };
        if (c.file_path && c.line) body.inline = { path: c.file_path, to: c.line };
        const data = await bbRequest('POST', `/repositories/${workspace}/${repo}/pullrequests/${pr_id}/comments`, body);
        const type = c.file_path ? `inline ${c.file_path}:${c.line}` : 'general';
        results.push(`✓ [${i + 1}/${comments.length}] #${data.id} (${type})`);
      } catch (e) {
        errors.push(`✗ [${i + 1}/${comments.length}] ${e.message}`);
      }
      if (i < comments.length - 1) await new Promise(r => setTimeout(r, delay_ms));
    }
    const summary = `${results.length} created, ${errors.length} failed.`;
    return { content: [{ type: 'text', text: [summary, ...results, ...errors].join('\n') }] };
  }
);

// ── 3. List comments ───────────────────────────────────────────────────────
server.registerTool(
  'list_pr_comments',
  {
    description: 'Lists all comments on a Pull Request, including their ID, author, content, and whether they are inline.',
    inputSchema: {
      workspace: z.string().describe('Bitbucket workspace slug'),
      repo:      z.string().describe('Repository slug'),
      pr_id:     z.number().int().positive().describe('Pull Request ID'),
      page:      z.number().int().positive().optional().default(1).describe('Page number (default 1)'),
      pagelen:   z.number().int().min(1).max(100).optional().default(20).describe('Results per page (max 100)'),
    },
  },
  async ({ workspace, repo, pr_id, page, pagelen }) => {
    const data = await bbRequest('GET', `/repositories/${workspace}/${repo}/pullrequests/${pr_id}/comments?page=${page}&pagelen=${pagelen}`);
    if (!data.values?.length) {
      return { content: [{ type: 'text', text: 'No comments found on this PR.' }] };
    }
    const lines = [`${data.size} comment(s) total — page ${page}:\n`];
    for (const c of data.values) {
      const author   = c.author?.display_name ?? 'unknown';
      const type     = c.inline ? ` [inline ${c.inline.path}:${c.inline.to}]` : '';
      const preview  = c.content?.raw?.slice(0, 120).replace(/\n/g, ' ');
      const resolved = c.resolution ? ' ✓ resolved' : '';
      lines.push(`• #${c.id}${type}${resolved} — @${author}\n  "${preview}${(c.content?.raw?.length ?? 0) > 120 ? '…' : ''}"`);
    }
    if (data.next) lines.push(`\n→ More results available. Use page=${page + 1} to continue.`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── 4. Get a comment by ID ─────────────────────────────────────────────────
server.registerTool(
  'get_pr_comment',
  {
    description: 'Retrieves the full details of a specific comment by its ID.',
    inputSchema: {
      workspace:  z.string().describe('Bitbucket workspace slug'),
      repo:       z.string().describe('Repository slug'),
      pr_id:      z.number().int().positive().describe('Pull Request ID'),
      comment_id: z.number().int().positive().describe('Comment ID'),
    },
  },
  async ({ workspace, repo, pr_id, comment_id }) => {
    const c = await bbRequest('GET', `/repositories/${workspace}/${repo}/pullrequests/${pr_id}/comments/${comment_id}`);
    const type     = c.inline ? `inline at ${c.inline.path}:${c.inline.to}` : 'general';
    const resolved = c.resolution ? `\nResolved by: @${c.resolution.user?.display_name ?? '?'} (${c.resolution.date?.slice(0, 10)})` : '';
    const parent   = c.parent ? `\nReply to: #${c.parent.id}` : '';
    return {
      content: [{
        type: 'text',
        text: [`Comment #${c.id} (${type})`, `Author: @${c.author?.display_name} — ${c.created_on?.slice(0, 10)}`, resolved, parent, `\n${c.content?.raw}`].join('\n'),
      }],
    };
  }
);

// ── 5. Edit a comment ──────────────────────────────────────────────────────
server.registerTool(
  'update_pr_comment',
  {
    description: 'Edits the content of an existing comment.',
    inputSchema: {
      workspace:   z.string().describe('Bitbucket workspace slug'),
      repo:        z.string().describe('Repository slug'),
      pr_id:       z.number().int().positive().describe('Pull Request ID'),
      comment_id:  z.number().int().positive().describe('ID of the comment to edit'),
      new_content: z.string().min(1).describe('New content for the comment'),
    },
  },
  async ({ workspace, repo, pr_id, comment_id, new_content }) => {
    const data = await bbRequest('PUT', `/repositories/${workspace}/${repo}/pullrequests/${pr_id}/comments/${comment_id}`, { content: { raw: new_content } });
    return { content: [{ type: 'text', text: `✓ Comment #${data.id} updated.` }] };
  }
);

// ── 6. Delete a comment ────────────────────────────────────────────────────
server.registerTool(
  'delete_pr_comment',
  {
    description: 'Deletes a comment from a Pull Request. This action is irreversible.',
    inputSchema: {
      workspace:  z.string().describe('Bitbucket workspace slug'),
      repo:       z.string().describe('Repository slug'),
      pr_id:      z.number().int().positive().describe('Pull Request ID'),
      comment_id: z.number().int().positive().describe('ID of the comment to delete'),
    },
  },
  async ({ workspace, repo, pr_id, comment_id }) => {
    await bbRequestRaw('DELETE', `/repositories/${workspace}/${repo}/pullrequests/${pr_id}/comments/${comment_id}`);
    return { content: [{ type: 'text', text: `✓ Comment #${comment_id} deleted.` }] };
  }
);

// ── 7. Reply to a comment ──────────────────────────────────────────────────
server.registerTool(
  'reply_to_pr_comment',
  {
    description: 'Replies to an existing comment, creating a conversation thread.',
    inputSchema: {
      workspace:  z.string().describe('Bitbucket workspace slug'),
      repo:       z.string().describe('Repository slug'),
      pr_id:      z.number().int().positive().describe('Pull Request ID'),
      comment_id: z.number().int().positive().describe('ID of the comment to reply to'),
      content:    z.string().min(1).describe('Reply content'),
    },
  },
  async ({ workspace, repo, pr_id, comment_id, content }) => {
    const data = await bbRequest('POST', `/repositories/${workspace}/${repo}/pullrequests/${pr_id}/comments`, { content: { raw: content }, parent: { id: comment_id } });
    return { content: [{ type: 'text', text: `✓ Reply #${data.id} created in thread of #${comment_id}.` }] };
  }
);

// ── 8. Resolve a comment ───────────────────────────────────────────────────
server.registerTool(
  'resolve_pr_comment',
  {
    description: 'Marks an inline comment as resolved.',
    inputSchema: {
      workspace:  z.string().describe('Bitbucket workspace slug'),
      repo:       z.string().describe('Repository slug'),
      pr_id:      z.number().int().positive().describe('Pull Request ID'),
      comment_id: z.number().int().positive().describe('ID of the comment to resolve'),
    },
  },
  async ({ workspace, repo, pr_id, comment_id }) => {
    await bbRequestRaw('POST', `/repositories/${workspace}/${repo}/pullrequests/${pr_id}/comments/${comment_id}/resolve`);
    return { content: [{ type: 'text', text: `✓ Comment #${comment_id} marked as resolved.` }] };
  }
);

// ── 9. Unresolve a comment ─────────────────────────────────────────────────
server.registerTool(
  'unresolve_pr_comment',
  {
    description: 'Reopens a comment that was previously marked as resolved.',
    inputSchema: {
      workspace:  z.string().describe('Bitbucket workspace slug'),
      repo:       z.string().describe('Repository slug'),
      pr_id:      z.number().int().positive().describe('Pull Request ID'),
      comment_id: z.number().int().positive().describe('ID of the comment to reopen'),
    },
  },
  async ({ workspace, repo, pr_id, comment_id }) => {
    await bbRequestRaw('DELETE', `/repositories/${workspace}/${repo}/pullrequests/${pr_id}/comments/${comment_id}/resolve`);
    return { content: [{ type: 'text', text: `✓ Comment #${comment_id} reopened.` }] };
  }
);

// ── 10. Approve a PR ──────────────────────────────────────────────────────
server.registerTool(
  'approve_pr',
  {
    description: 'Approves a Pull Request on behalf of the authenticated user. Note: you cannot approve your own PR.',
    inputSchema: {
      workspace: z.string().describe('Bitbucket workspace slug'),
      repo:      z.string().describe('Repository slug'),
      pr_id:     z.number().int().positive().describe('Pull Request ID'),
    },
  },
  async ({ workspace, repo, pr_id }) => {
    const data = await bbRequest('POST', `/repositories/${workspace}/${repo}/pullrequests/${pr_id}/approve`);
    return { content: [{ type: 'text', text: `✓ PR #${pr_id} approved by @${data.user?.display_name ?? 'you'}.` }] };
  }
);

// ── 11. Remove approval ────────────────────────────────────────────────────
server.registerTool(
  'remove_pr_approval',
  {
    description: 'Removes a previously submitted approval from a Pull Request.',
    inputSchema: {
      workspace: z.string().describe('Bitbucket workspace slug'),
      repo:      z.string().describe('Repository slug'),
      pr_id:     z.number().int().positive().describe('Pull Request ID'),
    },
  },
  async ({ workspace, repo, pr_id }) => {
    await bbRequestRaw('DELETE', `/repositories/${workspace}/${repo}/pullrequests/${pr_id}/approve`);
    return { content: [{ type: 'text', text: `✓ Approval removed from PR #${pr_id}.` }] };
  }
);

// ── 12. Request changes ────────────────────────────────────────────────────
server.registerTool(
  'request_changes',
  {
    description: 'Marks a Pull Request as needing changes, blocking the merge until the author addresses the feedback. Note: you cannot request changes on your own PR.',
    inputSchema: {
      workspace: z.string().describe('Bitbucket workspace slug'),
      repo:      z.string().describe('Repository slug'),
      pr_id:     z.number().int().positive().describe('Pull Request ID'),
    },
  },
  async ({ workspace, repo, pr_id }) => {
    const data = await bbRequest('POST', `/repositories/${workspace}/${repo}/pullrequests/${pr_id}/request-changes`);
    return { content: [{ type: 'text', text: `✓ Changes requested on PR #${pr_id} by @${data.user?.display_name ?? 'you'}.` }] };
  }
);

// ── 13. Remove changes request ─────────────────────────────────────────────
server.registerTool(
  'remove_changes_request',
  {
    description: 'Removes a previously submitted changes_requested status from a Pull Request.',
    inputSchema: {
      workspace: z.string().describe('Bitbucket workspace slug'),
      repo:      z.string().describe('Repository slug'),
      pr_id:     z.number().int().positive().describe('Pull Request ID'),
    },
  },
  async ({ workspace, repo, pr_id }) => {
    await bbRequestRaw('DELETE', `/repositories/${workspace}/${repo}/pullrequests/${pr_id}/request-changes`);
    return { content: [{ type: 'text', text: `✓ Changes request removed from PR #${pr_id}.` }] };
  }
);

// ── 14. Full code review ───────────────────────────────────────────────────
server.registerTool(
  'submit_review',
  {
    description: `Simulates a full code review: posts all comments at once then sets the approval state.
Since the Bitbucket Cloud API does not expose a pending-comments endpoint, this tool approximates
batched reviews by posting all comments in quick succession before setting the final verdict.
Note: you cannot approve or request changes on a PR you authored.`,
    inputSchema: {
      workspace: z.string().describe('Bitbucket workspace slug'),
      repo:      z.string().describe('Repository slug'),
      pr_id:     z.number().int().positive().describe('Pull Request ID'),
      verdict:   z.enum(['approve', 'request_changes', 'comment_only']).describe(
        '"approve" approves the PR, "request_changes" blocks merging, "comment_only" only posts comments.'
      ),
      comments: z.array(z.object({
        content:   z.string().min(1).describe('Comment content (markdown supported)'),
        file_path: z.string().optional().describe('File path for an inline comment'),
        line:      z.number().int().positive().optional().describe('Line number for an inline comment'),
      })).describe('List of review comments to post (can be empty)'),
      summary:  z.string().optional().describe('Optional general summary comment posted last, before the verdict'),
      delay_ms: z.number().int().min(0).max(2000).optional().default(200).describe('Delay between comment requests in ms (default 200)'),
    },
  },
  async ({ workspace, repo, pr_id, verdict, comments, summary, delay_ms }) => {
    const base = `/repositories/${workspace}/${repo}/pullrequests/${pr_id}`;
    const log = [];
    let failed = 0;

    // 1. Post inline / general comments
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i];
      try {
        const body = { content: { raw: c.content } };
        if (c.file_path && c.line) body.inline = { path: c.file_path, to: c.line };
        const data = await bbRequest('POST', `${base}/comments`, body);
        const loc = c.file_path ? `inline ${c.file_path}:${c.line}` : 'general';
        log.push(`✓ [${i + 1}/${comments.length}] Comment #${data.id} (${loc})`);
      } catch (e) {
        log.push(`✗ [${i + 1}/${comments.length}] ${e.message}`);
        failed++;
      }
      if (i < comments.length - 1) await new Promise(r => setTimeout(r, delay_ms));
    }

    // 2. Post optional summary comment
    if (summary) {
      try {
        const data = await bbRequest('POST', `${base}/comments`, { content: { raw: summary } });
        log.push(`✓ Summary comment #${data.id} posted.`);
      } catch (e) {
        log.push(`✗ Summary comment failed: ${e.message}`);
        failed++;
      }
    }

    // 3. Set verdict
    if (verdict === 'approve') {
      try {
        const data = await bbRequest('POST', `${base}/approve`);
        log.push(`✓ PR #${pr_id} approved by @${data.user?.display_name ?? 'you'}.`);
      } catch (e) {
        log.push(`✗ Approval failed: ${e.message}`);
        failed++;
      }
    } else if (verdict === 'request_changes') {
      try {
        const data = await bbRequest('POST', `${base}/request-changes`);
        log.push(`✓ Changes requested on PR #${pr_id} by @${data.user?.display_name ?? 'you'}.`);
      } catch (e) {
        log.push(`✗ Request changes failed: ${e.message}`);
        failed++;
      }
    }

    const total = comments.length + (summary ? 1 : 0) + (verdict !== 'comment_only' ? 1 : 0);
    const summaryLine = `Review submitted — ${total - failed}/${total} actions succeeded.`;
    return { content: [{ type: 'text', text: [summaryLine, ...log].join('\n') }] };
  }
);

// ── 15. Get PR status ──────────────────────────────────────────────────────
server.registerTool(
  'get_pr_status',
  {
    description: 'Returns a summary of a Pull Request: title, state, author, reviewers with their approval status, and comment count.',
    inputSchema: {
      workspace: z.string().describe('Bitbucket workspace slug'),
      repo:      z.string().describe('Repository slug'),
      pr_id:     z.number().int().positive().describe('Pull Request ID'),
    },
  },
  async ({ workspace, repo, pr_id }) => {
    const pr = await bbRequest('GET', `/repositories/${workspace}/${repo}/pullrequests/${pr_id}`);
    const reviewers = (pr.participants ?? [])
      .filter(p => p.role === 'REVIEWER')
      .map(p => {
        const name  = p.user?.display_name ?? '?';
        const state = p.approved ? '✓ approved' : p.state === 'changes_requested' ? '✗ changes requested' : '○ pending';
        return `  ${state} — @${name}`;
      });
    const lines = [
      `PR #${pr_id}: ${pr.title}`,
      `State:    ${pr.state}`,
      `Author:   @${pr.author?.display_name ?? '?'}`,
      `Branch:   ${pr.source?.branch?.name} → ${pr.destination?.branch?.name}`,
      `Created:  ${pr.created_on?.slice(0, 10)}`,
      `Comments: ${pr.comment_count ?? 0}`,
      '',
      `Reviewers (${reviewers.length}):`,
      ...(reviewers.length ? reviewers : ['  none assigned']),
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

await server.connect(new StdioServerTransport());