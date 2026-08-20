import type { INodeProperties } from 'n8n-workflow';

/**
 * Every description below is written for two readers at once: the workflow author in the editor,
 * and the LLM that sees these strings as its tool documentation when the node is used as an AI
 * Agent tool. That's why each operation states its trigger condition ("call this when…"), not
 * just its effect — the state machine is in the engine, but the model still decides which
 * operation to reach for.
 */

const showFor = (operations: string[]): INodeProperties['displayOptions'] => ({
	show: { operation: operations },
});

export const expertOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	default: 'delegate',
	options: [
		{
			name: 'Approve (Spends Money)',
			value: 'approve',
			description:
				'Approve the current quote so the human expert starts work — the ONLY operation that charges the Tendem account. It re-reads the live quote and approves only when it is at or under Max Price; anything else returns the quote as data with nothing charged. Call this only after a human or workflow policy has accepted a "quote" outcome.',
			action: 'Approve the quote under a price cap',
		},
		{
			name: 'Check & Advance',
			value: 'check',
			description:
				'Poll a delegated task until it needs something, and say what as data: a scoping question from Tendem (outcome "question"), a quote to decide on (outcome "quote"), or the finished result. Never spends money. Call this after delegating, and again whenever the outcome is "pending".',
			action: 'Check a delegated task and advance it',
		},
		{
			name: 'Delegate',
			value: 'delegate',
			description:
				'Create a Tendem task for a vetted human expert from a plain-language request, optionally attaching input files. Nothing is charged: Tendem scopes the work and quotes a price first. Returns the task_id every later call needs. Call this exactly once per piece of work.',
			action: 'Delegate work to a human expert',
		},
		{
			name: 'Reply',
			value: 'reply',
			description:
				'Answer Tendem\'s scoping question (from a "question" outcome), then keep advancing the task in the same call. Use the task_id from this conversation.',
			action: 'Reply to the expert service and continue',
		},
		{
			name: 'Wait for Result',
			value: 'waitResult',
			description:
				'Block until the verified result is ready and return it: markdown plus downloadable file URLs. Never spends money. Outcome "pending" means the work is still running — call again with the same task_id.',
			action: 'Wait for the verified result',
		},
	],
};

export const expertFields: INodeProperties[] = [
	{
		displayName: 'Request',
		name: 'request',
		type: 'string',
		typeOptions: { rows: 5 },
		default: '',
		required: true,
		displayOptions: showFor(['delegate']),
		description:
			'The work to delegate, in plain language: what to do and what the deliverable looks like. Pass the requester\'s intent faithfully — Tendem\'s orchestrator does the scoping and asks follow-up questions. Tendem declines data-scraping work by policy.',
		placeholder:
			'Research the top 5 competitors in EU freight brokerage and summarise their pricing models in a one-page brief',
	},
	{
		displayName: 'Task Name',
		name: 'taskName',
		type: 'string',
		default: '',
		displayOptions: showFor(['delegate']),
		description:
			'Optional short name shown in Tendem lists. Left empty, one is derived from the request.',
	},
	{
		displayName: 'Conversation ID',
		name: 'conversationId',
		type: 'string',
		default: '',
		displayOptions: showFor(['delegate']),
		description:
			'Optional stable identifier letting Tendem correlate several tasks from one conversation',
	},
	{
		displayName: 'Input Binary Fields',
		name: 'inputBinaryFields',
		type: 'string',
		default: '',
		displayOptions: showFor(['delegate']),
		description:
			'Comma-separated names of binary properties on the input item to upload as task input files. Uploaded after creation and announced to the expert automatically.',
		placeholder: 'data, attachment_1',
	},
	{
		displayName: 'Task ID',
		name: 'taskId',
		type: 'string',
		default: '',
		required: true,
		displayOptions: showFor(['approve', 'check', 'reply', 'waitResult']),
		description:
			'The task UUID returned by Delegate. Always the one from this conversation — never invent or reuse an ID from elsewhere.',
	},
	{
		displayName: 'Reply Text',
		name: 'replyText',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		required: true,
		displayOptions: showFor(['reply']),
		description:
			'The answer to Tendem\'s scoping question. Answer from the conversation\'s context when it contains the answer; otherwise relay the question to the user first.',
	},
	{
		displayName: 'Approval Policy',
		name: 'approvalPolicy',
		type: 'options',
		default: 'never',
		displayOptions: showFor(['approve']),
		description:
			'Where the spend decision comes from. Whatever the policy, the engine re-reads the LIVE quote at approval time and an unparsable price is never paid.',
		options: [
			{
				name: 'Always Approve',
				value: 'always',
				description: 'Approve whatever the current quote is. For fully trusted flows only.',
			},
			{
				name: 'From Decision Field',
				value: 'decision',
				description:
					'Approve only when the Decision field below is true — drive it by expression from any upstream node: a Slack approval, a Wait-for-form, an IF branch',
			},
			{
				name: 'Never (Report Quote Only)',
				value: 'never',
				description: 'Never approve — return the current quote as data and charge nothing',
			},
			{
				name: 'Under Max Price',
				value: 'underMaxPrice',
				description: 'Approve automatically when the live quote is at or under Max Price',
			},
		],
	},
	{
		displayName: 'Max Price',
		name: 'maxPrice',
		type: 'number',
		default: 0,
		typeOptions: { minValue: 0 },
		displayOptions: { show: { operation: ['approve'], approvalPolicy: ['underMaxPrice'] } },
		description:
			'Spend cap in USD, set by the workflow author. The live quote is approved only when it is at or under this; a higher quote returns as data and charges nothing. This is the consent to spend — set it deliberately.',
	},
	{
		displayName: 'Decision',
		name: 'approveDecision',
		type: 'boolean',
		default: false,
		displayOptions: { show: { operation: ['approve'], approvalPolicy: ['decision'] } },
		description:
			'Whether to commit the spend. Drive it from an expression carrying an upstream decision — a Slack approval, a Wait-for-form answer, an IF branch.',
	},
	{
		displayName: 'Max Rounds',
		name: 'maxRounds',
		type: 'number',
		default: 20,
		typeOptions: { minValue: 1, maxValue: 240 },
		displayOptions: showFor(['check', 'reply', 'waitResult']),
		description:
			'How many 30-second server-side waits to spend before returning outcome "pending". Waiting is server-side long-polling — no busy loop, and pending is resumable: call again with the same task_id.',
	},
];
