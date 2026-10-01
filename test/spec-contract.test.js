'use strict';
// Fetches the live Linnx OpenAPI spec and checks that every operation, parameter, option value,
// page size and collection key this node relies on still exists. Catches an API change before a
// user does. Set LINNX_SPEC_URL to point at another environment.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Linnx } = require('./helpers');

const SPEC_URL = process.env.LINNX_SPEC_URL || 'https://app.linnx.ai/api/v1/openapi.json';

// What the node sends. `options` names the node property whose option values must all be valid
// for that API parameter; `max` is the largest value the node ever sends.
const CONTRACT = [
	{
		method: 'get',
		path: '/api/v1/chats',
		collection: 'chats',
		params: {
			limit: { max: 50 },
			page: {},
			spam: {},
			archive: {},
			sort: { options: ['chat', 'getAll', 'filters.sort'] },
			search: {},
			categoryTag: {},
		},
	},
	{ method: 'get', path: '/api/v1/chats/{chatId}', params: { chatId: {}, limit: { max: 200 }, page: {} } },
	{ method: 'post', path: '/api/v1/chats/{chatId}/draft', params: { chatId: {} }, body: ['text'] },
	{
		method: 'get',
		path: '/api/v1/connections',
		collection: 'connections',
		params: {
			limit: { max: 100 },
			page: {},
			sort: { options: ['connection', 'getAll', 'filters.sort'] },
			favourites: {},
			search: {},
		},
	},
	{
		method: 'get',
		path: '/api/v1/requests',
		collection: 'items',
		params: {
			direction: { options: ['request', 'getAll', 'direction'] },
			status: { options: ['request', 'getAll', 'status'] },
			limit: { max: 200 },
			page: {},
		},
	},
	{
		method: 'get',
		path: '/api/v1/posts',
		collection: 'posts',
		params: { limit: { max: 100 }, page: {}, startDate: {}, endDate: {}, category: {}, includeReposts: {} },
	},
	{
		method: 'get',
		path: '/api/v1/analytics/dashboard',
		params: { period: { options: ['analytics', 'dashboard', 'period'] } },
	},
	{
		method: 'get',
		path: '/api/v1/analytics/posts',
		params: {
			range: { options: ['analytics', 'posts', 'range'] },
			startDate: {},
			endDate: {},
			limit: { max: 25 },
		},
	},
	{ method: 'get', path: '/api/v1/analytics/followers', params: { startDate: {}, endDate: {} } },
	{
		method: 'get',
		path: '/api/v1/analytics/messages',
		params: { range: { options: ['analytics', 'messages', 'range'] } },
	},
	{
		method: 'get',
		path: '/api/v1/analytics/connections',
		params: { range: { options: ['analytics', 'connections', 'range'] } },
	},
];

const ERROR_CODES = [
	'invalid_request',
	'unauthorized',
	'subscription_inactive',
	'not_found',
	'rate_limited',
	'internal_error',
];

function nodeOptionValues(resource, operation, dotted) {
	const [name, sub] = dotted.split('.');
	const props = new Linnx().description.properties.filter(
		(p) =>
			p.name === name &&
			p.displayOptions?.show?.resource?.includes(resource) &&
			p.displayOptions?.show?.operation?.includes(operation),
	);
	assert.ok(props.length > 0, `node has no property ${dotted} for ${resource}:${operation}`);
	return props.flatMap((p) => {
		const target = sub ? p.options.find((o) => o.name === sub) : p;
		assert.ok(target, `node has no ${dotted}`);
		return target.options.map((o) => o.value);
	});
}

function resolve(spec, obj) {
	while (obj && obj.$ref) {
		obj = obj.$ref
			.replace(/^#\//, '')
			.split('/')
			.reduce((o, k) => o[k], spec);
	}
	return obj;
}

let spec;
test.before(async () => {
	const res = await fetch(SPEC_URL);
	assert.equal(res.status, 200, `could not fetch ${SPEC_URL}`);
	spec = await res.json();
});

test('spec is still OpenAPI 3.1 at version 1.x', () => {
	assert.match(spec.openapi, /^3\.1\./);
	assert.match(spec.info.version, /^1\./, `node was built against 1.x, spec is ${spec.info.version}`);
});

for (const c of CONTRACT) {
	test(`${c.method.toUpperCase()} ${c.path}`, () => {
		const op = spec.paths[c.path]?.[c.method];
		assert.ok(op, 'operation no longer exists');

		const params = Object.fromEntries(
			[...(spec.paths[c.path].parameters || []), ...(op.parameters || [])]
				.map((p) => resolve(spec, p))
				.map((p) => [p.name, p]),
		);

		for (const [name, expect] of Object.entries(c.params)) {
			const p = params[name];
			assert.ok(p, `parameter "${name}" is gone`);
			const schema = resolve(spec, p.schema) || {};
			if (expect.max !== undefined && schema.maximum !== undefined) {
				assert.ok(expect.max <= schema.maximum, `${name}: node sends ${expect.max}, spec max is ${schema.maximum}`);
			}
			if (expect.options) {
				const allowed = schema.enum;
				assert.ok(Array.isArray(allowed), `${name} is no longer an enum`);
				for (const v of nodeOptionValues(...expect.options)) {
					assert.ok(allowed.includes(v), `${name}: node offers "${v}", spec allows ${allowed.join(', ')}`);
				}
			}
		}

		if (c.body) {
			const schema = resolve(spec, op.requestBody?.content?.['application/json']?.schema);
			for (const key of c.body) assert.ok(schema?.properties?.[key], `body field "${key}" is gone`);
		}

		if (c.collection) {
			const ok = resolve(spec, op.responses['200']);
			const schema = resolve(spec, ok.content['application/json'].schema);
			// Flatten allOf, which is how the spec composes rows with the pagination envelope.
			const props = {};
			const collect = (s) => {
				s = resolve(spec, s);
				Object.assign(props, s.properties || {});
				(s.allOf || []).forEach(collect);
			};
			collect(schema);
			assert.ok(props[c.collection], `collection key "${c.collection}" is gone`);
			for (const k of ['page', 'pageSize', 'totalPages', 'hasMore', 'total']) {
				assert.ok(props[k], `pagination field "${k}" is gone`);
			}
		}
	});
}

test('every error code the node switches on is still documented', () => {
	const text = JSON.stringify(spec);
	for (const code of ERROR_CODES) assert.ok(text.includes(`"${code}"`), `error code ${code} is gone`);
});

test('the spec still has no send, accept, decline or publish operation', () => {
	const writes = Object.entries(spec.paths).flatMap(([path, ops]) =>
		Object.keys(ops)
			.filter((m) => ['post', 'put', 'patch', 'delete'].includes(m))
			.map((m) => `${m.toUpperCase()} ${path}`),
	);
	// If Linnx ever adds one, this fails so a human decides deliberately what the node does.
	assert.deepEqual(writes, ['POST /api/v1/chats/{chatId}/draft']);
});
