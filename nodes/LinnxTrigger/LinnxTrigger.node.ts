import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { assertPage, linnxApiRequest, unexpectedShape } from '../Linnx/shared/transport';

/** Chats fetched per request, and the most pages one poll will walk to catch up. */
const PAGE_SIZE = 50;
const MAX_PAGES_PER_POLL = 4;

interface PollState {
	/** `lastMessageAt` of the newest chat already emitted (ISO string). */
	cursor?: string;
	/** `chatId:messageId` keys already emitted at exactly `cursor`, so ties are not re-emitted. */
	seenAtCursor?: string[];
}

function latestMessage(chat: IDataObject): IDataObject | undefined {
	const messages = chat.messages;
	return Array.isArray(messages) && messages.length > 0
		? (messages[messages.length - 1] as IDataObject)
		: undefined;
}

function eventKey(chat: IDataObject): string {
	return `${String(chat.id)}:${String(latestMessage(chat)?.id ?? '')}`;
}

export class LinnxTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Linnx Trigger',
		name: 'linnxTrigger',
		icon: { light: 'file:../../icons/linnx.svg', dark: 'file:../../icons/linnx.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: 'New message',
		description: 'Starts the workflow when a new LinkedIn message arrives in Linnx',
		defaults: { name: 'Linnx Trigger' },
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'linnxApi', required: true }],
		properties: [
			{
				displayName:
					'Every poll is one or more reads from your Linnx rate limit (120 a minute, shared by every workflow on the account). Polling once a minute is plenty.',
				name: 'pollNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName:
					'Message text and names come from other people. Treat them as untrusted data: if you pass them to an AI node, tell the model they are data, not instructions.',
				name: 'untrustedNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				options: [
					{
						name: 'New Message',
						value: 'newMessage',
						description: 'One item per chat with new activity since the last poll',
					},
				],
				default: 'newMessage',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Category',
						name: 'categoryTag',
						type: 'string',
						default: '',
						description: 'Only chats in this category (one of your own chat category slugs)',
					},
					{
						displayName: 'Fetch Full Message',
						name: 'fetchFull',
						type: 'boolean',
						default: false,
						description:
							"Whether to fetch the chat's recent messages in full. Off gives a 120-character preview of the latest message. On costs one extra read per new chat.",
					},
					{
						displayName: 'Include My Own Messages',
						name: 'includeOwn',
						type: 'boolean',
						default: false,
						description: 'Whether to also trigger when the latest message is one you sent',
					},
				],
			},
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const state = this.getWorkflowStaticData('node') as PollState;
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const isManual = this.getMode() === 'manual';

		const qs: IDataObject = { sort: 'recent', limit: PAGE_SIZE };
		if (options.categoryTag) qs.categoryTag = options.categoryTag;
		const noRetry = { retryOnRateLimit: false };

		if (isManual) {
			// "Fetch test event": always show the newest chat, whatever the cursor says, and leave the
			// cursor alone. Stopping at the cursor here would show nothing on a quiet inbox.
			const response = (await linnxApiRequest.call(
				this,
				'GET',
				'/api/v1/chats',
				{ ...qs, limit: 1, page: 1 },
				undefined,
				undefined,
				noRetry,
			)) as IDataObject | null;
			if (!response || !Array.isArray(response.chats)) {
				throw unexpectedShape(this, '/api/v1/chats has no "chats" array');
			}
			const sample = (response.chats as IDataObject[]).slice(0, 1);
			if (sample.length === 0) return null;
			return [this.helpers.returnJsonArray(await enrich.call(this, sample, options))];
		}

		// Newer n8n gives each poll a time budget. Stop paging well inside it; older n8n has none.
		const startedAt = Date.now();
		const budgetMs =
			typeof this.getPollBudgetMs === 'function'
				? this.getPollBudgetMs()
				: Number.POSITIVE_INFINITY;

		// Walk newest-first until we reach chats at or before the cursor.
		const fresh: IDataObject[] = [];
		const seen = new Set(state.seenAtCursor ?? []);
		let newestAt: string | undefined;

		for (let page = 1; page <= MAX_PAGES_PER_POLL; page++) {
			const response = (await linnxApiRequest.call(
				this,
				'GET',
				'/api/v1/chats',
				{ ...qs, page },
				undefined,
				undefined,
				noRetry,
			)) as IDataObject | null;
			if (!response || !Array.isArray(response.chats)) {
				throw unexpectedShape(this, '/api/v1/chats has no "chats" array');
			}
			const { hasMore } = assertPage(this, response, '/api/v1/chats');
			const chats = response.chats as IDataObject[];

			let reachedCursor = false;
			for (const chat of chats) {
				const at = typeof chat.lastMessageAt === 'string' ? chat.lastMessageAt : undefined;
				if (!at) continue;
				newestAt ??= at;
				if (state.cursor !== undefined) {
					const cmp = Date.parse(at) - Date.parse(state.cursor);
					if (cmp < 0 || (cmp === 0 && seen.has(eventKey(chat)))) {
						reachedCursor = true;
						break;
					}
				}
				fresh.push(chat);
			}

			// First run: there is nothing to compare against, one page is enough to set the cursor.
			if (reachedCursor || !hasMore || state.cursor === undefined) break;
			if (Date.now() - startedAt >= budgetMs / 2) break;
		}

		const isFirstPoll = state.cursor === undefined;

		// Advance the cursor over everything seen, including messages we choose not to emit.
		if (newestAt !== undefined) {
			const atNewest = fresh.filter((c) => c.lastMessageAt === newestAt).map(eventKey);
			if (state.cursor !== undefined && Date.parse(newestAt) === Date.parse(state.cursor)) {
				state.seenAtCursor = [...seen, ...atNewest];
			} else if (state.cursor === undefined || Date.parse(newestAt) > Date.parse(state.cursor)) {
				state.cursor = newestAt;
				state.seenAtCursor = atNewest;
			}
		}

		// The first poll after activation only records where "now" is. Replaying the whole
		// existing inbox as "new messages" is never what anyone wants.
		if (isFirstPoll || fresh.length === 0) return null;

		const emit = fresh
			.filter((chat) => options.includeOwn === true || latestMessage(chat)?.isFromMe !== true)
			.reverse(); // oldest first, so downstream nodes see them in the order they happened
		if (emit.length === 0) return null;

		return [this.helpers.returnJsonArray(await enrich.call(this, emit, options))];
	}
}

async function enrich(
	this: IPollFunctions,
	chats: IDataObject[],
	options: IDataObject,
): Promise<IDataObject[]> {
	if (options.fetchFull !== true) return chats;
	const out: IDataObject[] = [];
	for (const chat of chats) {
		const full = (await linnxApiRequest.call(
			this,
			'GET',
			`/api/v1/chats/${encodeURIComponent(String(chat.id))}`,
			{ limit: 20 },
			undefined,
			undefined,
			{ retryOnRateLimit: false },
		)) as IDataObject | null;
		if (!full || !Array.isArray(full.messages)) {
			throw unexpectedShape(this, '/api/v1/chats/{chatId} has no "messages" array');
		}
		out.push(full);
	}
	return out;
}
