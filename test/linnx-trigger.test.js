'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LinnxTrigger, fakeHttp, context, page } = require('./helpers');

const chat = (id, at, { fromMe = false, msg = `${id}-m` } = {}) => ({
	id,
	lastMessageAt: at,
	messages: [{ id: msg, isFromMe: fromMe, body: 'preview' }],
});

function poller(staticData, options = {}, mode = 'trigger') {
	return async (responses) => {
		const http = fakeHttp(responses);
		const ctx = context({ params: { options }, http, staticData, mode });
		const result = await new LinnxTrigger().poll.call(ctx);
		return { result, calls: http.calls, ids: result ? result[0].map((i) => i.json.id) : [] };
	};
}

test('first poll only records the cursor and emits nothing', async () => {
	const state = {};
	const { result, calls } = await poller(state)([
		page('chats', [chat('a', '2026-10-01T10:00:00Z'), chat('b', '2026-10-01T09:00:00Z')], { hasMore: true }),
	]);
	assert.equal(result, null);
	assert.equal(calls.length, 1, 'first poll reads one page, not the whole inbox');
	assert.equal(calls[0].qs.sort, 'recent');
	assert.equal(state.cursor, '2026-10-01T10:00:00Z');
});

test('later polls emit only newer chats, oldest first, and skip my own messages', async () => {
	const state = { cursor: '2026-10-01T10:00:00Z', seenAtCursor: ['a:a-m'] };
	const { ids } = await poller(state)([
		page('chats', [
			chat('d', '2026-10-01T10:03:00Z'),
			chat('mine', '2026-10-01T10:02:00Z', { fromMe: true }),
			chat('c', '2026-10-01T10:01:00Z'),
			chat('a', '2026-10-01T10:00:00Z'),
		]),
	]);
	assert.deepEqual(ids, ['c', 'd']);
	assert.equal(state.cursor, '2026-10-01T10:03:00Z');
});

test('nothing new means no items and no cursor movement', async () => {
	const state = { cursor: '2026-10-01T10:00:00Z', seenAtCursor: ['a:a-m'] };
	const { result } = await poller(state)([page('chats', [chat('a', '2026-10-01T10:00:00Z')])]);
	assert.equal(result, null);
	assert.equal(state.cursor, '2026-10-01T10:00:00Z');
});

test('a second chat at exactly the cursor time is still emitted, once', async () => {
	const state = { cursor: '2026-10-01T10:00:00Z', seenAtCursor: ['a:a-m'] };
	const poll = poller(state);
	const first = await poll([page('chats', [chat('b', '2026-10-01T10:00:00Z'), chat('a', '2026-10-01T10:00:00Z')])]);
	assert.deepEqual(first.ids, ['b']);
	const second = await poll([page('chats', [chat('b', '2026-10-01T10:00:00Z'), chat('a', '2026-10-01T10:00:00Z')])]);
	assert.equal(second.result, null);
});

test('catching up walks more pages until it reaches the cursor', async () => {
	const state = { cursor: '2026-10-01T09:00:00Z', seenAtCursor: [] };
	const { ids, calls } = await poller(state)([
		page('chats', [chat('z', '2026-10-01T12:00:00Z')], { hasMore: true }),
		page('chats', [chat('y', '2026-10-01T11:00:00Z'), chat('old', '2026-10-01T08:00:00Z')], { page: 2, hasMore: true }),
	]);
	assert.deepEqual(ids, ['y', 'z']);
	assert.equal(calls.length, 2);
});

test('include my own messages option', async () => {
	const state = { cursor: '2026-10-01T10:00:00Z', seenAtCursor: [] };
	const { ids } = await poller(state, { includeOwn: true })([
		page('chats', [chat('mine', '2026-10-01T10:02:00Z', { fromMe: true })]),
	]);
	assert.deepEqual(ids, ['mine']);
});

test('manual "fetch test event" returns the newest chat without moving the cursor', async () => {
	const state = { cursor: '2026-10-01T10:00:00Z', seenAtCursor: [] };
	const { ids } = await poller(state, {}, 'manual')([
		page('chats', [chat('n', '2026-10-01T10:05:00Z'), chat('o', '2026-10-01T10:04:00Z')]),
	]);
	assert.deepEqual(ids, ['n']);
	assert.equal(state.cursor, '2026-10-01T10:00:00Z');
});

test('fetch full message replaces the preview with the chat', async () => {
	const state = { cursor: '2026-10-01T10:00:00Z', seenAtCursor: [] };
	const { result, calls } = await poller(state, { fetchFull: true })([
		page('chats', [chat('c', '2026-10-01T10:01:00Z')]),
		{ body: { id: 'c', messages: [{ id: 'm', body: 'full text' }], messagePage: { hasMore: false } } },
	]);
	assert.equal(result[0][0].json.messages[0].body, 'full text');
	assert.equal(calls[1].url, 'https://app.linnx.ai/api/v1/chats/c');
});

test('manual test event still shows the newest chat when nothing is new since the cursor', async () => {
	const state = { cursor: '2026-10-01T10:00:00Z', seenAtCursor: ['a:a-m'] };
	const { ids, calls } = await poller(state, {}, 'manual')([page('chats', [chat('a', '2026-10-01T10:00:00Z')])]);
	assert.deepEqual(ids, ['a']);
	assert.equal(calls[0].qs.limit, 1);
	assert.equal(state.cursor, '2026-10-01T10:00:00Z');
});

test('a 429 inside a poll is not slept on; it fails with a rate-limited failure for n8n to back off', async () => {
	const state = { cursor: '2026-10-01T10:00:00Z', seenAtCursor: [] };
	const http = fakeHttp([
		{ statusCode: 429, headers: { 'retry-after': '5' }, body: { error: { code: 'rate_limited', message: 'slow' } } },
	]);
	const ctx = context({ params: { options: {} }, http, staticData: state });
	await assert.rejects(new LinnxTrigger().poll.call(ctx), (err) => {
		assert.deepEqual(err.failure, { cause: 'rate-limited', retryAfterMs: 5000 });
		return true;
	});
	assert.equal(http.calls.length, 1);
});

test('paging stops early when the poll time budget is nearly spent', async () => {
	const state = { cursor: '2026-10-01T00:00:00Z', seenAtCursor: [] };
	const http = fakeHttp([
		page('chats', [chat('z', '2026-10-01T12:00:00Z')], { hasMore: true }),
		page('chats', [chat('y', '2026-10-01T11:00:00Z')], { page: 2, hasMore: true }),
	]);
	const ctx = context({ params: { options: {} }, http, staticData: state });
	ctx.getPollBudgetMs = () => 0;
	const result = await new LinnxTrigger().poll.call(ctx);
	assert.equal(http.calls.length, 1);
	assert.deepEqual(result[0].map((i) => i.json.id), ['z']);
});
