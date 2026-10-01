import type {
	Failure,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	IPollFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

export const BASE_URL = 'https://app.linnx.ai';

/** The API version this package was built and tested against. Shown in errors and the README. */
export const API_VERSION = 'v1 (spec 1.0.0)';

type Context = IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions;

/** How many times a 429 is retried, and the longest Retry-After the node will wait out. */
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_AFTER_SECONDS = 60;

function parseBody(body: unknown): unknown {
	if (typeof body !== 'string') return body;
	if (body.trim() === '') return undefined;
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}

function errorEnvelope(body: unknown): { code: string; message: string } | undefined {
	if (body === null || typeof body !== 'object') return undefined;
	const error = (body as IDataObject).error as IDataObject | undefined;
	if (!error || typeof error !== 'object') return undefined;
	return { code: String(error.code ?? ''), message: String(error.message ?? '') };
}

/**
 * Turn a non-2xx response into an error a person can act on. Switches on `error.code`, which is
 * stable; the API's own message is passed through as the description because it names bounds.
 */
function toNodeError(
	ctx: Context,
	status: number,
	body: unknown,
	headers: IDataObject,
	itemIndex?: number,
): NodeApiError {
	const envelope = errorEnvelope(body);
	const raw = (envelope
		? { ...envelope, httpCode: status }
		: { httpCode: status, body }) as unknown as JsonObject;
	const opts = { httpCode: String(status), itemIndex };
	// `failure` tells n8n why a call failed, so a polling trigger can back off or ask the user to
	// act. Newer n8n reads it; older versions ignore it.
	const failure = (f: Failure) => ({ failure: f });

	switch (envelope?.code) {
		case 'unauthorized':
			// 401 bodies are identical for unknown, revoked, malformed and missing keys, on purpose.
			return new NodeApiError(ctx.getNode(), raw, {
				...opts,
				...failure({ cause: 'credential-invalid' }),
				message: 'Linnx did not accept the API key',
				description:
					'The key is unknown, revoked or mistyped, or was made in a different Linnx environment. Linnx does not say which, by design. Check the credential, or create a new key at app.linnx.ai under Profile → API keys.',
			});
		case 'subscription_inactive':
			return new NodeApiError(ctx.getNode(), raw, {
				...opts,
				...failure({ cause: 'configuration-invalid' }),
				message: 'Your Linnx subscription is inactive',
				description:
					'The API key itself is fine, so creating a new key will not help. Reactivate the subscription in Linnx and this same key works again straight away.',
			});
		case 'rate_limited': {
			const retryAfter = headers['retry-after'];
			const seconds = Number(retryAfter);
			return new NodeApiError(ctx.getNode(), raw, {
				...opts,
				...failure({
					cause: 'rate-limited',
					...(Number.isFinite(seconds) && seconds >= 0 ? { retryAfterMs: seconds * 1000 } : {}),
				}),
				message: 'Linnx rate limit reached',
				description: `Limits are 120 reads and 30 draft saves a minute, shared by every key and workflow on the same Linnx account.${
					retryAfter !== undefined ? ` Linnx asked to wait ${String(retryAfter)} seconds.` : ''
				} Poll less often or spread workflows out.`,
			});
		}
		case 'not_found':
			return new NodeApiError(ctx.getNode(), raw, {
				...opts,
				message: 'Not found',
				description:
					envelope.message ||
					'No such chat on this Linnx account. An id from another account looks exactly like one that does not exist.',
			});
		case 'invalid_request':
			return new NodeApiError(ctx.getNode(), raw, {
				...opts,
				message: 'Linnx refused the request',
				description: envelope.message,
			});
		case 'internal_error':
			return new NodeApiError(ctx.getNode(), raw, {
				...opts,
				...failure({ cause: 'temporarily-unavailable' }),
				message: 'Linnx could not complete the request',
				description: envelope.message,
			});
	}

	if (envelope) {
		// A code this node was not built to know about. Fail loudly rather than guess.
		return new NodeApiError(ctx.getNode(), raw, {
			...opts,
			message: `Linnx answered with a code this node does not recognise: ${envelope.code}`,
			description: `${envelope.message} (This node was built against Linnx API ${API_VERSION}. Updating the node may help.)`,
		});
	}

	return new NodeApiError(ctx.getNode(), raw, {
		...opts,
		...(status >= 500 ? failure({ cause: 'temporarily-unavailable' }) : {}),
		message: `Linnx returned HTTP ${status} without an explanation`,
		description:
			status === 405
				? 'The API does not accept this method on this path. The node may be out of date with the Linnx API.'
				: `This node was built against Linnx API ${API_VERSION}. The response did not match it.`,
	});
}

export async function linnxApiRequest(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	qs: IDataObject = {},
	body?: IDataObject,
	itemIndex?: number,
	{ retryOnRateLimit = true }: { retryOnRateLimit?: boolean } = {},
): Promise<unknown> {
	const options: IHttpRequestOptions = {
		method,
		url: `${BASE_URL}${path}`,
		qs,
		body,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};

	for (let attempt = 0; ; attempt++) {
		const response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'linnxApi',
			options,
		)) as IN8nHttpFullResponse;

		const status = response.statusCode;
		const headers = (response.headers ?? {}) as IDataObject;
		const parsed = parseBody(response.body);

		if (status >= 200 && status < 300) {
			if (errorEnvelope(parsed)) throw toNodeError(this, status, parsed, headers, itemIndex);
			return parsed;
		}

		// Polling triggers pass retryOnRateLimit: false. Sleeping inside a poll eats its time budget;
		// the error's `failure` lets n8n schedule the back-off instead.
		if (status === 429 && retryOnRateLimit && attempt < MAX_RATE_LIMIT_RETRIES) {
			// Honour Retry-After. Retrying immediately would just meet the limit again.
			const retryAfter = Number(headers['retry-after']);
			if (Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= MAX_RETRY_AFTER_SECONDS) {
				await sleep(Math.ceil(retryAfter) * 1000 + 250);
				continue;
			}
		}

		throw toNodeError(this, status, parsed, headers, itemIndex);
	}
}

/** Fail loudly when a response does not have the shape this node was built against. */
export function unexpectedShape(
	ctx: Context,
	what: string,
	itemIndex?: number,
): NodeOperationError {
	return new NodeOperationError(
		ctx.getNode(),
		`Linnx returned a response this node does not understand: ${what}`,
		{
			itemIndex,
			description: `This node was built against Linnx API ${API_VERSION}. Check for an update to n8n-nodes-linnx.`,
		},
	);
}

interface PageEnvelope {
	page: number;
	hasMore: boolean;
}

function assertPage(ctx: Context, page: unknown, where: string, itemIndex?: number): PageEnvelope {
	const p = page as IDataObject | null;
	if (!p || typeof p !== 'object' || typeof p.hasMore !== 'boolean') {
		throw unexpectedShape(ctx, `${where} has no boolean "hasMore"`, itemIndex);
	}
	return p as unknown as PageEnvelope;
}

/**
 * Walk a paginated collection. Loops on `hasMore` and nothing else. `collectionKey` differs by
 * endpoint (`chats`, `connections`, `posts`, `items`), so it is always passed explicitly.
 * `max` stops early once enough rows are in hand; undefined means everything.
 */
export async function linnxApiRequestAllItems(
	this: Context,
	path: string,
	collectionKey: string,
	qs: IDataObject,
	pageSize: number,
	max: number | undefined,
	itemIndex?: number,
): Promise<IDataObject[]> {
	const rows: IDataObject[] = [];
	let page = 1;
	// Fixed for the whole walk: page N means rows (N-1)*limit onwards, so changing it mid-walk
	// would skip or repeat rows.
	const limit = max === undefined ? pageSize : Math.min(pageSize, max);

	for (;;) {
		const response = (await linnxApiRequest.call(
			this,
			'GET',
			path,
			{ ...qs, limit, page },
			undefined,
			itemIndex,
		)) as IDataObject | null;

		const collection = response?.[collectionKey];
		if (!Array.isArray(collection)) {
			throw unexpectedShape(this, `${path} has no "${collectionKey}" array`, itemIndex);
		}
		const { hasMore } = assertPage(this, response, path, itemIndex);

		rows.push(...(collection as IDataObject[]));
		if (!hasMore) break;
		if (max !== undefined && rows.length >= max) break;
		page++;
	}

	return max === undefined ? rows : rows.slice(0, max);
}

export { assertPage };
