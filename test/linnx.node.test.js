'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Linnx, fakeHttp, context, page, errorBody } = require('./helpers');

const run = (params, routes) => {
	const http = fakeHttp(routes);
	const ctx = context({ params, http });
	return { promise: new Linnx().execute.call(ctx), calls: http.calls };
};

test('get many chats loops on hasMore with a fixed page size, and stops at the limit', async () => {
	const rows = (from, n) => Array.from({ length: n }, (_, k) => ({ id: `c${from + k}` }));
	const { promise, calls } = run(
		{ resource: 'chat', operation: 'getAll', returnAll: false, limit: 70, filters: { spam: true, search: '' } },
		[page('chats', rows(0, 50), { hasMore: true }), page('chats', rows(50, 50), { page: 2, hasMore: true })],
	);
	const [out] = await promise;
	assert.equal(out.length, 70);
	assert.deepEqual(
		calls.map((c) => [c.qs.page, c.qs.limit]),
		[
			[1, 50],
			[2, 50],
		],
	);
	assert.equal(calls[0].qs.spam, true);
	assert.ok(!('search' in calls[0].qs), 'empty filters are not sent');
	assert.equal(calls[0].credentialType, 'linnxApi');
	assert.equal(calls[0].url, 'https://app.linnx.ai/api/v1/chats');
});

test('return all keeps going until hasMore is false, ignoring totalPages', async () => {
	const p1 = page('connections', [{ id: 'a' }], { hasMore: true });
	p1.body.totalPages = 1; // a lying totalPages must not stop the walk
	const { promise, calls } = run({ resource: 'connection', operation: 'getAll', returnAll: true, filters: {} }, [
		p1,
		page('connections', [{ id: 'b' }], { page: 2 }),
	]);
	const [out] = await promise;
	assert.deepEqual(
		out.map((o) => o.json.id),
		['a', 'b'],
	);
	assert.equal(calls[0].qs.limit, 100);
});

test('connection requests read the "items" key', async () => {
	const { promise, calls } = run(
		{ resource: 'request', operation: 'getAll', direction: 'SENT', status: 'ACCEPTED', returnAll: false, limit: 5 },
		[page('items', [{ id: 'r1' }])],
	);
	const [out] = await promise;
	assert.equal(out[0].json.id, 'r1');
	assert.equal(calls[0].url, 'https://app.linnx.ai/api/v1/requests');
	assert.deepEqual(calls[0].qs, { direction: 'SENT', status: 'ACCEPTED', limit: 5, page: 1 });
});

test('a missing collection key fails loudly instead of returning nothing', async () => {
	const { promise } = run({ resource: 'post', operation: 'getAll', returnAll: true, filters: {} }, [
		page('data', [{ id: 'x' }]),
	]);
	await assert.rejects(promise, /does not understand.*"posts"/);
});

test('followers: a bare null with a 200 is "no history", not an error', async () => {
	const { promise } = run({ resource: 'analytics', operation: 'followers' }, [{ body: null }]);
	const [out] = await promise;
	assert.deepEqual(out[0].json, { hasHistory: false });
});

test('followers: a real series is passed through with hasHistory', async () => {
	const { promise } = run({ resource: 'analytics', operation: 'followers', startDate: '2026-09-01' }, [
		{ body: { totalFollowers: 10, dataPoints: [] } },
	]);
	const [out] = await promise;
	assert.equal(out[0].json.hasHistory, true);
	assert.equal(out[0].json.totalFollowers, 10);
});

test('followers sends days only, so a timestamp cannot turn real history into null', async () => {
	const { promise, calls } = run(
		{ resource: 'analytics', operation: 'followers', startDate: '2026-07-01T00:00:00', endDate: '2026-09-30T00:00:00.000Z' },
		[{ body: { totalFollowers: 1, dataPoints: [] } }],
	);
	await promise;
	assert.deepEqual(calls[0].qs, { startDate: '2026-07-01', endDate: '2026-09-30' });
});

test('dashboard sends period, not range', async () => {
	const { promise, calls } = run({ resource: 'analytics', operation: 'dashboard', period: 'week' }, [
		{ body: { x: 1 } },
	]);
	await promise;
	assert.deepEqual(calls[0].qs, { period: 'week' });
});

test('post stats with exact dates sends both bounds and no range', async () => {
	const { promise, calls } = run(
		{
			resource: 'analytics',
			operation: 'posts',
			window: 'dates',
			startDate: '2026-08-01T00:00:00',
			endDate: '2026-08-31T00:00:00.000Z',
			topPosts: 5,
		},
		[{ body: { byImpressions: [] } }],
	);
	await promise;
	// Days only: /analytics/posts answers 500 when a bound carries a time.
	assert.deepEqual(calls[0].qs, { startDate: '2026-08-01', endDate: '2026-08-31', limit: 5 });
});

test('save draft posts the text; clear draft posts an empty string', async () => {
	const ok = { body: { ok: true, chatId: 'c1', cleared: false } };
	const save = run({ resource: 'chat', operation: 'saveDraft', chatId: ' c1 ', text: 'Hello' }, [ok]);
	await save.promise;
	assert.equal(save.calls[0].method, 'POST');
	assert.equal(save.calls[0].url, 'https://app.linnx.ai/api/v1/chats/c1/draft');
	assert.deepEqual(save.calls[0].body, { text: 'Hello' });

	const clear = run({ resource: 'chat', operation: 'clearDraft', chatId: 'c1' }, [ok]);
	await clear.promise;
	assert.deepEqual(clear.calls[0].body, { text: '' });
});

test('get chat with all messages stitches pages back into reading order', async () => {
	const chat = (msgs, p, hasMore) => ({
		body: { id: 'c1', messages: msgs.map((id) => ({ id })), messagePage: { total: 4, page: p, pageSize: 2, totalPages: 2, hasMore } },
	});
	const { promise, calls } = run({ resource: 'chat', operation: 'get', chatId: 'c1', returnAllMessages: true }, [
		chat(['m3', 'm4'], 1, true),
		chat(['m1', 'm2'], 2, false),
	]);
	const [out] = await promise;
	assert.deepEqual(
		out[0].json.messages.map((m) => m.id),
		['m1', 'm2', 'm3', 'm4'],
	);
	assert.equal(calls[0].qs.limit, 200);
	assert.equal(out[0].json.messagePage.hasMore, false);
});

test('401 says the key was not accepted, without guessing why', async () => {
	const { promise } = run({ resource: 'analytics', operation: 'messages', range: '7d' }, [
		{ statusCode: 401, body: errorBody('unauthorized') },
	]);
	await assert.rejects(promise, (err) => {
		assert.match(err.message, /did not accept the API key/);
		assert.match(err.description, /does not say which/);
		return true;
	});
});

test('403 subscription_inactive says the key is fine', async () => {
	const { promise } = run({ resource: 'analytics', operation: 'messages', range: '7d' }, [
		{ statusCode: 403, body: errorBody('subscription_inactive') },
	]);
	await assert.rejects(promise, (err) => {
		assert.match(err.message, /subscription is inactive/);
		assert.match(err.description, /new key will not help/);
		return true;
	});
});

test('400 surfaces the API message, which names the bound', async () => {
	const { promise } = run({ resource: 'analytics', operation: 'messages', range: '7d' }, [
		{ statusCode: 400, body: errorBody('invalid_request', 'limit must be between 1 and 50.') },
	]);
	await assert.rejects(promise, (err) => {
		assert.match(err.description, /between 1 and 50/);
		return true;
	});
});

test('429 waits out Retry-After and retries', async () => {
	const { promise, calls } = run({ resource: 'analytics', operation: 'connections', range: '30d' }, [
		{ statusCode: 429, headers: { 'retry-after': '0' }, body: errorBody('rate_limited') },
		{ body: { ok: 1 } },
	]);
	const [out] = await promise;
	assert.equal(calls.length, 2);
	assert.equal(out[0].json.ok, 1);
});

test('429 with a long Retry-After fails with the wait in the message instead of hammering', async () => {
	const { promise, calls } = run({ resource: 'analytics', operation: 'connections', range: '30d' }, [
		{ statusCode: 429, headers: { 'retry-after': '600' }, body: errorBody('rate_limited') },
	]);
	await assert.rejects(promise, (err) => {
		assert.match(err.message, /rate limit/);
		assert.match(err.description, /wait 600 seconds/);
		return true;
	});
	assert.equal(calls.length, 1);
});

test('405 with an empty body is still an error', async () => {
	const { promise } = run({ resource: 'analytics', operation: 'connections', range: '30d' }, [
		{ statusCode: 405, body: '' },
	]);
	await assert.rejects(promise, /HTTP 405/);
});

test('an unknown error code fails loudly and names it', async () => {
	const { promise } = run({ resource: 'analytics', operation: 'connections', range: '30d' }, [
		{ statusCode: 409, body: errorBody('brand_new_code') },
	]);
	await assert.rejects(promise, /does not recognise: brand_new_code/);
});

test('the node has no operation that sends anything to LinkedIn', () => {
	const props = new Linnx().description.properties;
	const ops = props
		.filter((p) => p.name === 'operation')
		.flatMap((p) => p.options.map((o) => `${p.displayOptions.show.resource[0]}:${o.value}`));
	assert.deepEqual(ops.sort(), [
		'analytics:connections',
		'analytics:dashboard',
		'analytics:followers',
		'analytics:messages',
		'analytics:posts',
		'chat:clearDraft',
		'chat:get',
		'chat:getAll',
		'chat:saveDraft',
		'connection:getAll',
		'post:getAll',
		'request:getAll',
	]);
});

test('errors carry a failure cause n8n can act on', async () => {
	const cases = [
		[401, 'unauthorized', 'credential-invalid'],
		[403, 'subscription_inactive', 'configuration-invalid'],
		[500, 'internal_error', 'temporarily-unavailable'],
	];
	for (const [statusCode, code, cause] of cases) {
		const { promise } = run({ resource: 'analytics', operation: 'messages', range: '7d' }, [
			{ statusCode, body: errorBody(code) },
		]);
		await assert.rejects(promise, (err) => {
			assert.equal(err.failure?.cause, cause, code);
			return true;
		});
	}
});

test('post list dates are sent as days, including free-text dates from an expression', async () => {
	const { promise, calls } = run(
		{ resource: 'post', operation: 'getAll', returnAll: false, limit: 1, filters: { startDate: 'July 1, 2026 12:00 UTC', endDate: '2026-09-30T23:59:00' } },
		[page('posts', [])],
	);
	await promise;
	assert.equal(calls[0].qs.startDate, '2026-07-01');
	assert.equal(calls[0].qs.endDate, '2026-09-30');
});
