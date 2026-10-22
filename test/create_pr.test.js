// create_pr regression tests: in-memory MCP client + stubbed fetch (no network, fake credentials)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.BITBUCKET_EMAIL = 'test@example.com';
process.env.BITBUCKET_API_TOKEN = 'fake-token';
process.env.BITBUCKET_CONFIRM_MODE = 'auto';

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
const { createServer } = await import('../index.js');

const ME  = '{11111111-1111-1111-1111-111111111111}';
const R1  = '{22222222-2222-2222-2222-222222222222}';
const DEF = '{33333333-3333-3333-3333-333333333333}';
const USERS = { [ME]: 'Me Myself', [R1]: 'Rita Reviewer' };

// ── fetch stub ─────────────────────────────────────────────────────────────
let calls, state;
const json = (status, body) => new Response(JSON.stringify(body), { status });

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const method = init.method ?? 'GET';
  const path = decodeURIComponent(u.pathname.replace(/^\/2\.0/, ''));
  calls.push({ method, path, q: u.searchParams.get('q'), body: init.body ? JSON.parse(init.body) : undefined });
  if (method === 'GET' && path === '/user') return json(200, { uuid: ME });
  if (method === 'GET' && path.startsWith('/users/')) {
    const id = path.slice('/users/'.length);
    return USERS[id] ? json(200, { uuid: id, display_name: USERS[id] }) : json(404, { error: { message: 'not found' } });
  }
  if (method === 'GET' && path === '/repositories/ws/repo/effective-default-reviewers') {
    return json(200, { values: [{ user: { uuid: DEF, display_name: 'Default Dan' } }] });
  }
  if (method === 'GET' && path === '/repositories/ws/repo/pullrequests') {
    return state.preflightFails ? json(500, { error: { message: 'boom' } }) : json(200, { values: state.openPrs });
  }
  if (method === 'POST' && path === '/repositories/ws/repo/pullrequests') {
    const b = JSON.parse(init.body);
    const pr = {
      id: 7, title: b.title, draft: b.draft, close_source_branch: b.close_source_branch,
      source: b.source, destination: b.destination ?? { branch: { name: 'main' } },
      links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/7' } },
    };
    if (!state.omitReviewers) pr.reviewers = b.reviewers.map(r => ({ uuid: r.uuid, display_name: USERS[r.uuid] ?? 'Default Dan' }));
    return json(201, pr);
  }
  throw new Error(`unstubbed fetch ${method} ${url}`);
};

beforeEach(() => {
  calls = [];
  state = { openPrs: [], preflightFails: false, omitReviewers: false };
});

const posts = () => calls.filter(c => c.method === 'POST');

// ── client helpers ─────────────────────────────────────────────────────────
async function connect({ confirmMode = 'auto', elicit } = {}) {
  const server = createServer({ confirmMode });
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, elicit);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

// Schema errors may surface as a thrown McpError or as an isError result depending on SDK version
async function call(client, args) {
  try {
    const res = await client.callTool({ name: 'create_pr', arguments: args });
    return { isError: !!res.isError, text: res.content.map(c => c.text).join('\n') };
  } catch (e) {
    return { isError: true, text: e.message };
  }
}

const ARGS = {
  workspace: 'ws', repo: 'repo', title: 'Add feature',
  source_branch: 'feat/x', destination_branch: 'main',
  description: 'Line one\nLine two', reviewers: [R1],
};
const tokenOf = text => text.match(/^confirm_token: ([0-9a-f]{64})$/m)?.[1];

function recorder(result) {
  const seen = [];
  const handler = async req => { seen.push(req.params); return result; };
  return { seen, handler };
}

// ── dialog path ────────────────────────────────────────────────────────────
test('dialog decline creates nothing', async () => {
  const r = recorder({ action: 'decline' });
  const res = await call(await connect({ elicit: r.handler }), ARGS);
  assert.equal(r.seen.length, 1);
  assert.match(res.text, /declined/);
  assert.equal(posts().length, 0);
});

test('dialog accept without values fails closed', async () => {
  const r = recorder({ action: 'accept' });
  const res = await call(await connect({ elicit: r.handler }), ARGS);
  assert.equal(res.isError, true);
  assert.match(res.text, /dialog returned no values/);
  assert.equal(posts().length, 0);
});

test('dialog accept posts once with the chosen booleans', async () => {
  const r = recorder({ action: 'accept', content: { close_source_branch: false, draft: true } });
  const res = await call(await connect({ elicit: r.handler }), ARGS);
  assert.equal(res.isError, false, res.text);
  assert.match(r.seen[0].message, /^ {2}\| Line one$/m);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.close_source_branch, false);
  assert.equal(posts()[0].body.draft, true);
  assert.match(res.text, /Confirmed via: dialog/);
});

test('explicit self reviewer is dropped with a warning', async () => {
  const r = recorder({ action: 'accept', content: { close_source_branch: true, draft: false } });
  const res = await call(await connect({ elicit: r.handler }), { ...ARGS, reviewers: [ME, R1] });
  assert.equal(res.isError, false, res.text);
  assert.match(r.seen[0].message, /You were removed from reviewers/);
  assert.match(res.text, /You were removed from reviewers/);
  assert.deepEqual(posts()[0].body.reviewers.map(r => r.uuid).sort(), [R1, DEF].sort());
});

test('confirmMode preview ignores an elicitation-capable client', async () => {
  const r = recorder({ action: 'accept', content: { close_source_branch: true, draft: false } });
  const res = await call(await connect({ confirmMode: 'preview', elicit: r.handler }), ARGS);
  assert.equal(r.seen.length, 0);
  assert.match(res.text, /^PREVIEW — PR NOT created \(BITBUCKET_CONFIRM_MODE=preview\)/);
  assert.ok(tokenOf(res.text));
  assert.equal(posts().length, 0);
});

// ── preview + confirm_token path ───────────────────────────────────────────
test('preview without elicitation: no POST, token and full description shown', async () => {
  const res = await call(await connect(), ARGS);
  assert.equal(res.isError, false);
  assert.match(res.text, /^PREVIEW — PR NOT created/);
  assert.ok(tokenOf(res.text));
  assert.match(res.text, /^Description \(17 chars\):\n {2}\| Line one\n {2}\| Line two$/m);
  assert.equal(posts().length, 0);
  const pre = calls.find(c => c.path === '/repositories/ws/repo/pullrequests');
  assert.equal(pre.q, 'state="OPEN" AND source.branch.name="feat/x" AND destination.branch.name="main"');
});

test('long description is capped at 2000 chars with a NOT shown line', async () => {
  const res = await call(await connect(), { ...ARGS, description: 'x'.repeat(2500) });
  assert.match(res.text, /^ {2}\| … 500 more chars NOT shown$/m);
  assert.match(res.text, /^ {2}\| x{2000}$/m);
});

test('matching token posts once', async () => {
  const client = await connect();
  const token = tokenOf((await call(client, ARGS)).text);
  const res = await call(client, { ...ARGS, confirm_token: token });
  assert.equal(res.isError, false, res.text);
  assert.equal(posts().length, 1);
  assert.match(res.text, /Confirmed via: confirm_token/);
});

test('changed description with old token returns a new preview', async () => {
  const client = await connect();
  const token = tokenOf((await call(client, ARGS)).text);
  const res = await call(client, { ...ARGS, description: 'Something else', confirm_token: token });
  assert.equal(res.isError, false);
  assert.match(res.text, /^The arguments or reviewers changed since the previous preview/);
  assert.notEqual(tokenOf(res.text), token);
  assert.equal(posts().length, 0);
});

test('forged token returns a new preview', async () => {
  const res = await call(await connect(), { ...ARGS, confirm_token: 'deadbeef'.repeat(8) });
  assert.match(res.text, /^The arguments or reviewers changed/);
  assert.equal(posts().length, 0);
});

test('success output falls back to requested reviewers when 201 omits them', async () => {
  state.omitReviewers = true;
  const client = await connect();
  const token = tokenOf((await call(client, ARGS)).text);
  const res = await call(client, { ...ARGS, confirm_token: token });
  assert.match(res.text, /^Reviewers \(2\): Rita Reviewer, Default Dan \(requested; not echoed by API\)$/m);
});

// ── duplicate pre-flight ───────────────────────────────────────────────────
test('open duplicate PR aborts before any confirmation', async () => {
  state.openPrs = [{ id: 42, title: 'Existing', author: { display_name: 'Someone' }, destination: { branch: { name: 'main' } } }];
  const r = recorder({ action: 'accept', content: { close_source_branch: true, draft: false } });
  const res = await call(await connect({ elicit: r.handler }), ARGS);
  assert.equal(res.isError, true);
  assert.match(res.text, /PR #42 is already open from feat\/x → main \(Existing, by @Someone\); PR not created\./);
  assert.equal(r.seen.length, 0);
  assert.equal(posts().length, 0);
});

test('pre-flight lookup failure fails closed', async () => {
  state.preflightFails = true;
  const res = await call(await connect(), ARGS);
  assert.equal(res.isError, true);
  assert.match(res.text, /Could not check for an existing open PR \(boom\); PR not created\./);
  assert.equal(posts().length, 0);
});

// ── schema validation (no HTTP at all) ─────────────────────────────────────
for (const [name, args, msg] of [
  ['title with a line break', { ...ARGS, title: 'Add\nfeature' }, /title must be a single line/],
  ['reviewer "me"', { ...ARGS, reviewers: ['me'] }, /"me\\?" is not allowed/],
  ['branch with a double quote', { ...ARGS, source_branch: 'feat"x' }, /branch names cannot contain/],
]) {
  test(`rejects ${name}`, async () => {
    const res = await call(await connect(), args);
    assert.equal(res.isError, true);
    assert.match(res.text, msg);
    assert.equal(calls.length, 0);
  });
}
