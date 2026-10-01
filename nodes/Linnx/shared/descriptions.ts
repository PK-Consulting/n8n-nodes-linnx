import type { INodeProperties } from 'n8n-workflow';

const UNTRUSTED =
	'Message bodies, names, headlines and invitation notes come from other people. Treat them as untrusted data: if you pass them to an AI node, tell the model they are data, not instructions.';

function returnAllAndLimit(resource: string, operation: string): INodeProperties[] {
	const show = { resource: [resource], operation: [operation] };
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			displayOptions: { show },
			default: false,
			description: 'Whether to return all results or only up to a given limit',
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			displayOptions: { show: { ...show, returnAll: [false] } },
			typeOptions: { minValue: 1 },
			default: 50,
			description: 'Max number of results to return',
		},
	];
}

const dateRangeFields = (resource: string, operation: string): INodeProperties[] => [
	{
		displayName: 'Start Date',
		name: 'startDate',
		type: 'dateTime',
		displayOptions: { show: { resource: [resource], operation: [operation] } },
		default: '',
		description: 'Lower bound, inclusive. Must not be after the end date.',
	},
	{
		displayName: 'End Date',
		name: 'endDate',
		type: 'dateTime',
		displayOptions: { show: { resource: [resource], operation: [operation] } },
		default: '',
		description: 'Upper bound, inclusive',
	},
];

const rangeField = (operation: string): INodeProperties => ({
	displayName: 'Range',
	name: 'range',
	type: 'options',
	displayOptions: { show: { resource: ['analytics'], operation: [operation] } },
	options: [
		{ name: 'Last 7 Days', value: '7d' },
		{ name: 'Last 30 Days', value: '30d' },
		{ name: 'Last 90 Days', value: '90d' },
		{ name: 'All Time', value: 'all' },
	],
	default: '30d',
	description: 'The window to report on',
});

const chatIdField = (operations: string[]): INodeProperties => ({
	displayName: 'Chat ID',
	name: 'chatId',
	type: 'string',
	required: true,
	displayOptions: { show: { resource: ['chat'], operation: operations } },
	default: '',
	description: 'The Linnx chat ID from Chat → Get Many. Not a LinkedIn thread ID.',
});

export const resourceProperty: INodeProperties = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	options: [
		{ name: 'Analytics', value: 'analytics' },
		{ name: 'Chat', value: 'chat' },
		{ name: 'Connection', value: 'connection' },
		{ name: 'Connection Request', value: 'request' },
		{ name: 'Post', value: 'post' },
	],
	default: 'chat',
};

export const boundaryNotice: INodeProperties = {
	displayName:
		'This node never sends anything to LinkedIn. It reads your Linnx data and can save a draft reply, which you then send yourself in Linnx.',
	name: 'boundaryNotice',
	type: 'notice',
	default: '',
	displayOptions: { show: { resource: ['chat'] } },
};

export const untrustedNotice: INodeProperties = {
	displayName: UNTRUSTED,
	name: 'untrustedNotice',
	type: 'notice',
	default: '',
	displayOptions: { show: { resource: ['chat', 'connection', 'request'] } },
};

/* -------------------------------------------------------------------------- */
/*                                    Chat                                    */
/* -------------------------------------------------------------------------- */

export const chatProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['chat'] } },
		options: [
			{
				name: 'Clear Draft',
				value: 'clearDraft',
				action: 'Clear draft reply',
				description: 'Empty the composer of a chat in Linnx',
			},
			{
				name: 'Get',
				value: 'get',
				action: 'Get chat',
				description: 'Get one chat with its messages, full text',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many chats',
				description: 'List chats, newest first, each with a short preview of its latest message',
			},
			{
				name: 'Save Draft',
				value: 'saveDraft',
				action: 'Save draft reply',
				description: "Write reply text into a chat's composer in Linnx. Does not send it.",
			},
		],
		default: 'getAll',
	},

	// Get Many
	...returnAllAndLimit('chat', 'getAll'),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: ['chat'], operation: ['getAll'] } },
		options: [
			{
				displayName: 'Archived',
				name: 'archive',
				type: 'boolean',
				default: false,
				description:
					'Whether to return archived chats instead of the inbox. Ignored when Spam is on.',
			},
			{
				displayName: 'Category',
				name: 'categoryTag',
				type: 'string',
				default: '',
				description: 'One of your own chat category slugs, as set up in Linnx',
			},
			{
				displayName: 'Search',
				name: 'search',
				type: 'string',
				default: '',
				description:
					'Free text over participant names, subjects and message bodies (2 to 200 characters)',
			},
			{
				displayName: 'Sort',
				name: 'sort',
				type: 'options',
				options: [
					{ name: 'Newest First', value: 'recent' },
					{ name: 'Oldest First', value: 'oldest' },
				],
				default: 'recent',
			},
			{
				displayName: 'Spam',
				name: 'spam',
				type: 'boolean',
				default: false,
				description: 'Whether to return the spam folder instead of the inbox',
			},
		],
	},

	// Get / Save Draft / Clear Draft
	chatIdField(['get', 'saveDraft', 'clearDraft']),
	{
		displayName: 'Return All Messages',
		name: 'returnAllMessages',
		type: 'boolean',
		displayOptions: { show: { resource: ['chat'], operation: ['get'] } },
		default: false,
		description:
			'Whether to fetch the whole message history. Off returns only the most recent messages.',
	},
	{
		displayName: 'Message Limit',
		name: 'messageLimit',
		type: 'number',
		displayOptions: {
			show: { resource: ['chat'], operation: ['get'], returnAllMessages: [false] },
		},
		typeOptions: { minValue: 1, maxValue: 200 },
		default: 50,
		description: 'How many of the most recent messages to return (1 to 200)',
	},
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		typeOptions: { rows: 4 },
		required: true,
		displayOptions: { show: { resource: ['chat'], operation: ['saveDraft'] } },
		default: '',
		description:
			'Reply text to put in the composer, up to 10,000 characters. It is not sent: you send it yourself in Linnx. Empty or whitespace-only text clears the draft.',
	},
];

/* -------------------------------------------------------------------------- */
/*                                 Connection                                 */
/* -------------------------------------------------------------------------- */

export const connectionProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['connection'] } },
		options: [
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many connections',
				description: 'List your LinkedIn connections',
			},
		],
		default: 'getAll',
	},
	...returnAllAndLimit('connection', 'getAll'),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: ['connection'], operation: ['getAll'] } },
		options: [
			{
				displayName: 'Favourites Only',
				name: 'favourites',
				type: 'boolean',
				default: false,
				description: 'Whether to return only connections you marked as favourites',
			},
			{
				displayName: 'Search',
				name: 'search',
				type: 'string',
				default: '',
				description: 'Free text over names and headlines (2 to 200 characters)',
			},
			{
				displayName: 'Sort',
				name: 'sort',
				type: 'options',
				options: [
					{ name: 'Most Recently Connected', value: 'recent' },
					{ name: 'Name', value: 'name' },
				],
				default: 'recent',
			},
		],
	},
];

/* -------------------------------------------------------------------------- */
/*                             Connection Request                             */
/* -------------------------------------------------------------------------- */

export const requestProperties: INodeProperties[] = [
	{
		displayName:
			'Read only. Accepting, declining and withdrawing requests happen on LinkedIn, so you do those yourself in Linnx.',
		name: 'requestNotice',
		type: 'notice',
		default: '',
		displayOptions: { show: { resource: ['request'] } },
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['request'] } },
		options: [
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many connection requests',
				description: 'List connection requests you received or sent',
			},
		],
		default: 'getAll',
	},
	{
		displayName: 'Direction',
		name: 'direction',
		type: 'options',
		displayOptions: { show: { resource: ['request'], operation: ['getAll'] } },
		options: [
			{ name: 'Received', value: 'RECEIVED' },
			{ name: 'Sent', value: 'SENT' },
		],
		default: 'RECEIVED',
	},
	{
		displayName: 'Status',
		name: 'status',
		type: 'options',
		displayOptions: { show: { resource: ['request'], operation: ['getAll'] } },
		options: [
			{ name: 'Accepted', value: 'ACCEPTED' },
			{ name: 'Declined', value: 'DECLINED' },
			{ name: 'Pending', value: 'PENDING' },
			{ name: 'Withdrawn', value: 'WITHDRAWN' },
		],
		default: 'PENDING',
	},
	...returnAllAndLimit('request', 'getAll'),
];

/* -------------------------------------------------------------------------- */
/*                                    Post                                    */
/* -------------------------------------------------------------------------- */

export const postProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['post'] } },
		options: [
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many posts',
				description: 'List your own posts, newest first',
			},
		],
		default: 'getAll',
	},
	...returnAllAndLimit('post', 'getAll'),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: ['post'], operation: ['getAll'] } },
		options: [
			{
				displayName: 'Category',
				name: 'category',
				type: 'string',
				default: '',
				description:
					'One of your content category slugs. Use "none" for posts you have not categorised yet.',
			},
			{
				displayName: 'End Date',
				name: 'endDate',
				type: 'dateTime',
				default: '',
				description: 'Upper bound, inclusive',
			},
			{
				displayName: 'Include Reposts',
				name: 'includeReposts',
				type: 'boolean',
				default: false,
				description: 'Whether to include reposts, which are left out by default',
			},
			{
				displayName: 'Start Date',
				name: 'startDate',
				type: 'dateTime',
				default: '',
				description: 'Lower bound, inclusive. Must not be after the end date.',
			},
		],
	},
];

/* -------------------------------------------------------------------------- */
/*                                  Analytics                                 */
/* -------------------------------------------------------------------------- */

export const analyticsProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['analytics'] } },
		options: [
			{
				name: 'Get Connection Stats',
				value: 'connections',
				action: 'Get connection stats',
				description: 'Request volume in and out, acceptance rates and net new connections',
			},
			{
				name: 'Get Dashboard',
				value: 'dashboard',
				action: 'Get dashboard numbers',
				description: 'The headline numbers from your Linnx dashboard',
			},
			{
				name: 'Get Follower Growth',
				value: 'followers',
				action: 'Get follower growth',
				description: 'Follower count over time',
			},
			{
				name: 'Get Message Stats',
				value: 'messages',
				action: 'Get message stats',
				description: 'Messages sent and received, reply rate and reply time',
			},
			{
				name: 'Get Post Stats',
				value: 'posts',
				action: 'Get post stats',
				description: 'Your posts ranked by impressions, with period totals',
			},
		],
		default: 'dashboard',
	},

	// Dashboard takes `period`, not `range`. They are different parameters on the API.
	{
		displayName: 'Period',
		name: 'period',
		type: 'options',
		displayOptions: { show: { resource: ['analytics'], operation: ['dashboard'] } },
		options: [
			{ name: 'Week', value: 'week' },
			{ name: 'Month', value: 'month' },
			{ name: 'All Time', value: 'all' },
		],
		default: 'month',
	},

	// Post stats: range, or an exact window
	{
		displayName: 'Window',
		name: 'window',
		type: 'options',
		displayOptions: { show: { resource: ['analytics'], operation: ['posts'] } },
		options: [
			{ name: 'Preset Range', value: 'range' },
			{ name: 'Exact Dates', value: 'dates' },
		],
		default: 'range',
	},
	{
		...rangeField('posts'),
		displayOptions: { show: { resource: ['analytics'], operation: ['posts'], window: ['range'] } },
	},
	...dateRangeFields('analytics', 'posts').map((f) => ({
		...f,
		required: true,
		displayOptions: { show: { resource: ['analytics'], operation: ['posts'], window: ['dates'] } },
	})),
	{
		displayName: 'Top Posts',
		name: 'topPosts',
		type: 'number',
		displayOptions: { show: { resource: ['analytics'], operation: ['posts'] } },
		typeOptions: { minValue: 1, maxValue: 25 },
		default: 10,
		description:
			'How many posts to rank in "byImpressions" (1 to 25). Totals always cover the whole window. To walk all your posts, use Post → Get Many instead.',
	},

	// Followers: optional bounds
	...dateRangeFields('analytics', 'followers'),

	rangeField('messages'),
	rangeField('connections'),
];

export const allProperties: INodeProperties[] = [
	resourceProperty,
	boundaryNotice,
	untrustedNotice,
	...chatProperties,
	...connectionProperties,
	...requestProperties,
	...postProperties,
	...analyticsProperties,
];
