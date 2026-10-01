import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	JsonObject,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { allProperties } from './shared/descriptions';
import {
	assertPage,
	linnxApiRequest,
	linnxApiRequestAllItems,
	unexpectedShape,
} from './shared/transport';

/** Largest page size each list endpoint accepts. Out-of-range values are refused, not clamped. */
const PAGE_SIZE = {
	chats: 50,
	connections: 100,
	requests: 200,
	posts: 100,
	messages: 200,
} as const;

function compact(obj: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null || v === '') continue;
		out[k] = v;
	}
	return out;
}

/**
 * The calendar day a date field names, as YYYY-MM-DD. Every Linnx date parameter is a whole day
 * (the day as written, no timezone), and the API accepts ISO dates only, so the node sends days.
 * Anything n8n hands over (an ISO string, a Luxon DateTime, a free-text date from an expression)
 * is reduced to that. Two production bugs on 2026-10-01 came from timestamps in these fields.
 */
function dayParam(value: unknown): string | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	if (
		typeof value === 'object' &&
		typeof (value as { toISODate?: unknown }).toISODate === 'function'
	) {
		return (value as { toISODate: () => string }).toISODate();
	}
	const text = String(value).trim();
	const day = /^\d{4}-\d{2}-\d{2}/.exec(text);
	if (day) return day[0];
	const parsed = new Date(text);
	return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString().slice(0, 10);
}

export class Linnx implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Linnx',
		name: 'linnx',
		icon: { light: 'file:../../icons/linnx.svg', dark: 'file:../../icons/linnx.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Read your LinkedIn inbox, connections, posts and analytics from Linnx, and save draft replies. Never sends anything.',
		defaults: { name: 'Linnx' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'linnxApi', required: true }],
		properties: allProperties,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const rows = await runOperation.call(this, resource, operation, i);
				out.push(...rows.map((json) => ({ json, pairedItem: { item: i } })));
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// Errors from this node already explain themselves; anything else (a network failure,
				// say) is wrapped so n8n shows it with context.
				const nodeError =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
				throw nodeError;
			}
		}

		return [out];
	}
}

async function listAll(
	this: IExecuteFunctions,
	path: string,
	collectionKey: string,
	qs: IDataObject,
	pageSize: number,
	i: number,
): Promise<IDataObject[]> {
	const returnAll = this.getNodeParameter('returnAll', i) as boolean;
	const max = returnAll ? undefined : (this.getNodeParameter('limit', i) as number);
	return linnxApiRequestAllItems.call(this, path, collectionKey, qs, pageSize, max, i);
}

async function runOperation(
	this: IExecuteFunctions,
	resource: string,
	operation: string,
	i: number,
): Promise<IDataObject[]> {
	if (resource === 'chat') {
		if (operation === 'getAll') {
			const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
			return listAll.call(this, '/api/v1/chats', 'chats', compact(filters), PAGE_SIZE.chats, i);
		}

		const chatId = encodeURIComponent((this.getNodeParameter('chatId', i) as string).trim());
		if (!chatId) throw new NodeOperationError(this.getNode(), 'Chat ID is empty', { itemIndex: i });

		if (operation === 'get') return [await getChat.call(this, chatId, i)];

		if (operation === 'saveDraft' || operation === 'clearDraft') {
			const text = operation === 'saveDraft' ? (this.getNodeParameter('text', i) as string) : '';
			const response = (await linnxApiRequest.call(
				this,
				'POST',
				`/api/v1/chats/${chatId}/draft`,
				{},
				{ text },
				i,
			)) as IDataObject | null;
			if (!response || typeof response !== 'object' || response.ok !== true) {
				throw unexpectedShape(this, 'draft response has no "ok": true', i);
			}
			return [response];
		}
	}

	if (resource === 'connection' && operation === 'getAll') {
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		return listAll.call(
			this,
			'/api/v1/connections',
			'connections',
			compact(filters),
			PAGE_SIZE.connections,
			i,
		);
	}

	if (resource === 'request' && operation === 'getAll') {
		const qs = {
			direction: this.getNodeParameter('direction', i) as string,
			status: this.getNodeParameter('status', i) as string,
		};
		// The collection key here is `items`, not `requests`.
		return listAll.call(this, '/api/v1/requests', 'items', qs, PAGE_SIZE.requests, i);
	}

	if (resource === 'post' && operation === 'getAll') {
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const qs = compact({
			...filters,
			startDate: dayParam(filters.startDate),
			endDate: dayParam(filters.endDate),
		});
		return listAll.call(this, '/api/v1/posts', 'posts', qs, PAGE_SIZE.posts, i);
	}

	if (resource === 'analytics') {
		let path: string;
		let qs: IDataObject;

		switch (operation) {
			case 'dashboard':
				path = '/api/v1/analytics/dashboard';
				qs = { period: this.getNodeParameter('period', i) as string };
				break;
			case 'posts': {
				path = '/api/v1/analytics/posts';
				const limit = this.getNodeParameter('topPosts', i) as number;
				if (this.getNodeParameter('window', i) === 'dates') {
					// Both bounds are required together; one alone silently falls back to `range`.
					const startDate = dayParam(this.getNodeParameter('startDate', i));
					const endDate = dayParam(this.getNodeParameter('endDate', i));
					if (!startDate || !endDate) {
						throw new NodeOperationError(
							this.getNode(),
							'Exact dates need both a start date and an end date',
							{ itemIndex: i },
						);
					}
					qs = { startDate, endDate, limit };
				} else {
					qs = { range: this.getNodeParameter('range', i) as string, limit };
				}
				break;
			}
			case 'followers':
				path = '/api/v1/analytics/followers';
				qs = compact({
					startDate: dayParam(this.getNodeParameter('startDate', i, '')),
					endDate: dayParam(this.getNodeParameter('endDate', i, '')),
				});
				break;
			case 'messages':
				path = '/api/v1/analytics/messages';
				qs = { range: this.getNodeParameter('range', i) as string };
				break;
			case 'connections':
				path = '/api/v1/analytics/connections';
				qs = { range: this.getNodeParameter('range', i) as string };
				break;
			default:
				throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, {
					itemIndex: i,
				});
		}

		const response = await linnxApiRequest.call(this, 'GET', path, qs, undefined, i);

		if (operation === 'followers') {
			// A bare `null` with a 200 means no follower history yet. A real answer, not an error.
			if (response === null || response === undefined) return [{ hasHistory: false }];
			if (typeof response !== 'object') throw unexpectedShape(this, `${path} is not an object`, i);
			return [{ hasHistory: true, ...(response as IDataObject) }];
		}

		if (response === null || typeof response !== 'object' || Array.isArray(response)) {
			throw unexpectedShape(this, `${path} is not an object`, i);
		}
		return [response as IDataObject];
	}

	throw new NodeOperationError(
		this.getNode(),
		`Unknown operation "${operation}" for resource "${resource}"`,
		{ itemIndex: i },
	);
}

/**
 * One chat and its messages. The API pages messages backwards from the end of the conversation
 * (page 1 is the most recent block); pages are stitched back into reading order.
 */
async function getChat(this: IExecuteFunctions, chatId: string, i: number): Promise<IDataObject> {
	const returnAll = this.getNodeParameter('returnAllMessages', i) as boolean;
	const limit = returnAll
		? PAGE_SIZE.messages
		: (this.getNodeParameter('messageLimit', i) as number);
	const path = `/api/v1/chats/${chatId}`;

	let chat: IDataObject | undefined;
	const blocks: IDataObject[][] = [];

	for (let page = 1; ; page++) {
		const response = (await linnxApiRequest.call(
			this,
			'GET',
			path,
			{ limit, page },
			undefined,
			i,
		)) as IDataObject | null;

		if (!response || !Array.isArray(response.messages)) {
			throw unexpectedShape(this, `${path} has no "messages" array`, i);
		}
		const { hasMore } = assertPage(this, response.messagePage, `${path} messagePage`, i);

		chat ??= response;
		blocks.unshift(response.messages as IDataObject[]);
		if (!returnAll || !hasMore) {
			chat = { ...chat, messagePage: response.messagePage };
			break;
		}
	}

	const messages = blocks.flat();
	if (returnAll) {
		const page = chat.messagePage as IDataObject;
		chat.messagePage = {
			...page,
			page: 1,
			pageSize: messages.length,
			totalPages: 1,
			hasMore: false,
		};
	}
	return { ...chat, messages };
}
