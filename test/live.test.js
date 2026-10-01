'use strict';
// Runs the built node against the real API. Skipped unless LINNX_API_KEY is set. Use a key from a
// Linnx demo account (isDemo blocks every real LinkedIn write), never a customer account.
//
//   LINNX_API_KEY=lnx_... npm run test:live
//
// Read-only except for one draft save and clear on the first chat, which never leaves Linnx.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Linnx, LinnxTrigger } = require('./helpers');

const KEY = process.env.LINNX_API_KEY;
const opts = { skip: !KEY && 'LINNX_API_KEY not set' };

function liveContext(params, staticData = {}) {
	return {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, i, fb) => (name in params ? params[name] : typeof i === 'number' ? fb : i),
		getNode: () => ({ name: 'Linnx', type: 'n8n-nodes-linnx.linnx', typeVersion: 1, parameters: {} }),
		continueOnFail: () => false,
		getMode: () => 'trigger',
		getWorkflowStaticData: () => staticData,
		helpers: {
			returnJsonArray: (rows) => rows.map((json) => ({ json })),
			// What n8n does with the credential's `authenticate` block, plus its response handling.
			httpRequestWithAuthentication: async (_type, o) => {
				const url = new URL(o.url);
				for (const [k, v] of Object.entries(o.qs || {})) url.searchParams.set(k, String(v));
				const res = await fetch(url, {
					method: o.method,
					headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
					body: o.body ? JSON.stringify(o.body) : undefined,
				});
				const text = await res.text();
				let body = text;
				try {
					body = text === '' ? '' : JSON.parse(text);
				} catch {}
				return { statusCode: res.status, headers: Object.fromEntries(res.headers), body };
			},
		},
	};
}

const run = async (params) => (await new Linnx().execute.call(liveContext(params)))[0].map((i) => i.json);

test('chats, connections, requests and posts list', opts, async () => {
	const chats = await run({ resource: 'chat', operation: 'getAll', returnAll: false, limit: 3, filters: {} });
	assert.ok(chats.length <= 3);
	await run({ resource: 'connection', operation: 'getAll', returnAll: false, limit: 3, filters: {} });
	await run({ resource: 'request', operation: 'getAll', direction: 'RECEIVED', status: 'PENDING', returnAll: false, limit: 3 });
	await run({ resource: 'post', operation: 'getAll', returnAll: false, limit: 3, filters: {} });
});

test('a chat, and a draft saved then cleared', opts, async () => {
	const [first] = await run({ resource: 'chat', operation: 'getAll', returnAll: false, limit: 1, filters: {} });
	if (!first) return;
	const chat = await run({ resource: 'chat', operation: 'get', chatId: first.id, returnAllMessages: false, messageLimit: 5 });
	assert.equal(chat[0].id, first.id);
	const before = chat[0].draft;
	const saved = await run({ resource: 'chat', operation: 'saveDraft', chatId: first.id, text: 'n8n-nodes-linnx live test' });
	assert.equal(saved[0].cleared, false);
	if (before) {
		await run({ resource: 'chat', operation: 'saveDraft', chatId: first.id, text: before });
	} else {
		const cleared = await run({ resource: 'chat', operation: 'clearDraft', chatId: first.id });
		assert.equal(cleared[0].cleared, true);
	}
});

test('every analytics operation', opts, async () => {
	await run({ resource: 'analytics', operation: 'dashboard', period: 'month' });
	await run({ resource: 'analytics', operation: 'posts', window: 'range', range: '30d', topPosts: 3 });
	const [followers] = await run({ resource: 'analytics', operation: 'followers' });
	assert.equal(typeof followers.hasHistory, 'boolean');
	await run({ resource: 'analytics', operation: 'messages', range: '7d' });
	await run({ resource: 'analytics', operation: 'connections', range: '7d' });
});

test('trigger arms on first poll', opts, async () => {
	const state = {};
	const result = await new LinnxTrigger().poll.call(liveContext({ options: {} }, state));
	assert.equal(result, null);
});

test('a wrong key gets the unauthorized message', opts, async () => {
	const ctx = liveContext({ resource: 'analytics', operation: 'dashboard', period: 'week' });
	const real = ctx.helpers.httpRequestWithAuthentication;
	ctx.helpers.httpRequestWithAuthentication = async (t, o) => {
		const res = await fetch(o.url + '?period=week', { headers: { Authorization: 'Bearer lnx_wrong' } });
		return { statusCode: res.status, headers: {}, body: await res.json() };
	};
	await assert.rejects(new Linnx().execute.call(ctx), /did not accept the API key/);
	ctx.helpers.httpRequestWithAuthentication = real;
});

// Regression guard for an API bug found on 2026-10-01: date bounds with a time made
// /analytics/posts answer 500 and /analytics/followers answer null. The node now sends days,
// so this calls the API directly to keep the API itself honest.
test('date endpoints treat a timestamp like the same day', opts, async () => {
	const get = async (path, startDate, endDate) => {
		const url = new URL(`https://app.linnx.ai${path}`);
		url.searchParams.set('startDate', startDate);
		url.searchParams.set('endDate', endDate);
		const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
		return { status: res.status, body: await res.json() };
	};
	for (const path of ['/api/v1/analytics/posts', '/api/v1/analytics/followers', '/api/v1/posts']) {
		const day = await get(path, '2026-07-01', '2026-09-30');
		for (const [s, e] of [
			['2026-07-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z'],
			['2026-07-01T00:00:00', '2026-09-30T00:00:00'],
		]) {
			const ts = await get(path, s, e);
			assert.equal(ts.status, 200, `${path} with ${s}`);
			assert.equal(ts.body === null, day.body === null, `${path}: timestamp and day disagree on null`);
		}
	}
});
