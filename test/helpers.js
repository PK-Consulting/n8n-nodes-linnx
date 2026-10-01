'use strict';
// A minimal stand-in for the n8n runtime: enough of IExecuteFunctions / IPollFunctions to run
// the built nodes against scripted HTTP responses.

const { Linnx } = require('../dist/nodes/Linnx/Linnx.node.js');
const { LinnxTrigger } = require('../dist/nodes/LinnxTrigger/LinnxTrigger.node.js');

/**
 * `routes` is a function (request) => { statusCode, body, headers } or an array of those
 * returned in order. Every request is recorded in `calls`.
 */
function fakeHttp(routes) {
	const calls = [];
	let n = 0;
	const fn = async (credentialType, options) => {
		calls.push({ credentialType, ...options, qs: { ...(options.qs || {}) } });
		const res = typeof routes === 'function' ? routes(options, calls.length) : routes[n++];
		if (!res) throw new Error(`No scripted response for request #${calls.length} ${options.url}`);
		return { statusCode: 200, headers: {}, ...res };
	};
	return { fn, calls };
}

function context({ params = {}, http, staticData = {}, mode = 'trigger', items = [{ json: {} }] }) {
	return {
		getInputData: () => items,
		getNodeParameter: (name, _i, fallback) => {
			// Poll functions call getNodeParameter(name, fallback); execute ones (name, i, fallback).
			const fb = typeof _i === 'number' ? fallback : _i;
			return name in params ? params[name] : fb;
		},
		getNode: () => ({ name: 'Linnx', type: 'n8n-nodes-linnx.linnx', typeVersion: 1, parameters: {} }),
		continueOnFail: () => false,
		getMode: () => mode,
		getWorkflowStaticData: () => staticData,
		helpers: {
			httpRequestWithAuthentication: http.fn,
			returnJsonArray: (rows) => rows.map((json) => ({ json })),
		},
	};
}

function page(key, rows, { page = 1, hasMore = false, total = rows.length } = {}) {
	return {
		body: { [key]: rows, total, page, pageSize: rows.length, totalPages: hasMore ? page + 1 : page, hasMore },
	};
}

const errorBody = (code, message = `${code} message`) => ({ error: { code, message } });

module.exports = { Linnx, LinnxTrigger, fakeHttp, context, page, errorBody };
