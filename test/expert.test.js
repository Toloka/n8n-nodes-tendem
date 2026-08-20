'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
	advance,
	approve,
	delegate,
	reply,
	waitForResult,
	parsePrice,
	deriveTaskName,
	blobUploadUrl,
} = require('../dist/nodes/TendemExpert/engine.js');

const TASK_ID = '6435d8a2-9742-4723-be25-0f88726a1f16';

/** A scripted Tendem: each tool name maps to a handler (or a queue of them, consumed per call). */
function scriptedCaller(script) {
	const calls = [];
	return {
		calls,
		names: () => calls.map((c) => c.name),
		countOf: (name) => calls.filter((c) => c.name === name).length,
		async callTool(name, args) {
			calls.push({ name, args });
			const handler = script[name];
			if (handler === undefined) throw new Error(`unscripted tool call: ${name}`);
			if (Array.isArray(handler)) {
				const next = handler.length > 1 ? handler.shift() : handler[0];
				return typeof next === 'function' ? next(args) : next;
			}
			return typeof handler === 'function' ? handler(args) : handler;
		},
	};
}

function deps(caller) {
	return { caller, sleep: async () => {}, now: () => 0 };
}

// --- helpers ---------------------------------------------------------------

test('parsePrice reads every live price shape and rejects junk', () => {
	assert.equal(parsePrice('$40.00'), 40);
	assert.equal(parsePrice('1,250.50 USD'), 1250.5);
	assert.equal(parsePrice(25), 25);
	// The live get_contract shape, verified 2026-08-20 on a real quote:
	assert.equal(parsePrice({ amount: 3, currency: 'USD', formatted: '$3.00' }), 3);
	assert.equal(parsePrice({ formatted: '$7.50' }), 7.5);
	assert.equal(parsePrice('free-ish'), undefined);
	assert.equal(parsePrice(null), undefined);
	assert.equal(parsePrice({}), undefined);
});

test('approve handles the live money-object price end to end', async () => {
	const caller = scriptedCaller({
		get_task: { task_id: TASK_ID, name: 'Forecast', status: 'LISTENING' },
		get_contract: {
			state: 'available',
			contract: { title: 'Produce Berlin forecast' },
			price: { amount: 3, currency: 'USD', formatted: '$3.00' },
		},
		approve_task: { approved: true },
	});

	const out = await approve(deps(caller), { taskId: TASK_ID, maxPrice: 25 });

	assert.equal(out.outcome, 'approved');
	const approval = caller.calls.find((c) => c.name === 'approve_task');
	assert.equal(approval.args.price, '$3.00');
});

test('deriveTaskName trims to a short name and never returns empty', () => {
	assert.equal(deriveTaskName('Research the top 5 competitors in EU freight brokerage today'),
		'Research the top 5 competitors in EU freight');
	assert.equal(deriveTaskName('   '), 'Delegated task');
});

test('blobUploadUrl swaps the dfs host and inserts the name before the query', () => {
	assert.equal(
		blobUploadUrl('https://acc.dfs.core.windows.net/fs/task?sig=abc', 'data/input.csv'),
		'https://acc.blob.core.windows.net/fs/task/data/input.csv?sig=abc',
	);
});

// --- delegate ----------------------------------------------------------------

test('delegate creates the task and returns its id', async () => {
	const caller = scriptedCaller({
		create_task: { task_id: TASK_ID, status: 'ACTING' },
	});

	const out = await delegate(deps(caller), { request: 'Check the weather in Berlin' });

	assert.equal(out.outcome, 'created');
	assert.equal(out.task_id, TASK_ID);
	assert.deepEqual(caller.names(), ['create_task']);
	assert.equal(caller.calls[0].args.description, 'Check the weather in Berlin');
	assert.equal(caller.calls[0].args.name, 'Check the weather in Berlin');
});

test('delegate uploads files with the blob host swap and announces them', async () => {
	const puts = [];
	const caller = scriptedCaller({
		create_task: { task_id: TASK_ID, status: 'ACTING' },
		get_file_upload_url: {
			upload_url: 'https://acc.dfs.core.windows.net/fs/task?sig=abc',
		},
		read_chat: { messages: [], last_seen_offset: 2 },
		send_message: { response_type: 'sync', last_seen_offset: 3 },
	});

	const out = await delegate(deps(caller), {
		request: 'Summarise brief.pdf',
		files: { 'brief.pdf': Buffer.from('x') },
		putFile: async (url, data) => void puts.push({ url, bytes: data.length }),
	});

	assert.deepEqual(out.files_attached, ['brief.pdf']);
	assert.equal(puts[0].url, 'https://acc.blob.core.windows.net/fs/task/brief.pdf?sig=abc');
	const sent = caller.calls.find((c) => c.name === 'send_message');
	assert.match(sent.args.text, /brief\.pdf/);
	assert.equal(sent.args.last_seen_offset, 2);
});

// --- advance: the state machine ---------------------------------------------

test('await_input surfaces the question as data, chat read from offset 0', async () => {
	const caller = scriptedCaller({
		get_task: { task_id: TASK_ID, status: 'LISTENING', next_action: 'await_input' },
		read_chat: {
			messages: [{ offset: 0, text: 'brief' }, { offset: 1, text: 'What city exactly?' }],
			last_seen_offset: 2,
		},
	});

	const out = await advance(deps(caller), { taskId: TASK_ID });

	assert.equal(out.outcome, 'question');
	assert.equal(out.question, 'What city exactly?');
	assert.match(out.chat_transcript, /brief[\s\S]*What city exactly\?/);
	assert.equal(out.last_seen_offset, 2);
	assert.equal(caller.countOf('approve_task'), 0);
});

test('check surfaces a quote as data and can NEVER approve', async () => {
	const caller = scriptedCaller({
		get_task: { task_id: TASK_ID, status: 'LISTENING', next_action: 'await_user_approval' },
		get_contract: { state: 'available', contract: { title: 'Research' }, price: '$18.00' },
	});

	const out = await advance(deps(caller), { taskId: TASK_ID });

	assert.equal(out.outcome, 'quote');
	assert.equal(out.price_value, 18);
	assert.equal(out.charged, false);
	assert.equal(caller.countOf('approve_task'), 0);
});

// --- approve: the single spending path ---------------------------------------

test('approve pays the SERVER price when it fits under the cap, not a stale one', async () => {
	const caller = scriptedCaller({
		get_task: { task_id: TASK_ID, name: 'Research', status: 'LISTENING', price: '$99.00' },
		get_contract: { state: 'available', contract: { title: 'Research' }, price: '$18.00' },
		approve_task: { approved: true },
	});

	const out = await approve(deps(caller), { taskId: TASK_ID, maxPrice: 25 });

	assert.equal(out.outcome, 'approved');
	const approval = caller.calls.find((c) => c.name === 'approve_task');
	assert.equal(approval.args.price, '$18.00');
	assert.equal(out.approved_under_cap, 25);
});

test('approve refuses a quote over the cap and charges NOTHING', async () => {
	const caller = scriptedCaller({
		get_task: { task_id: TASK_ID, status: 'LISTENING' },
		get_contract: { state: 'available', contract: { title: 'Big job' }, price: '$180.00' },
	});

	const out = await approve(deps(caller), { taskId: TASK_ID, maxPrice: 25 });

	assert.equal(out.outcome, 'quote');
	assert.equal(out.over_cap, true);
	assert.equal(out.charged, false);
	assert.equal(caller.countOf('approve_task'), 0);
});

test('approve with the default cap of 0 refuses everything, however cheap', async () => {
	const caller = scriptedCaller({
		get_task: { task_id: TASK_ID, status: 'LISTENING' },
		get_contract: { state: 'available', contract: {}, price: '$0.50' },
	});

	const out = await approve(deps(caller), { taskId: TASK_ID, maxPrice: 0 });

	assert.equal(out.outcome, 'quote');
	assert.equal(caller.countOf('approve_task'), 0);
});

test('approve never pays an unparsable price, even under a generous cap', async () => {
	const caller = scriptedCaller({
		get_task: { task_id: TASK_ID, status: 'LISTENING' },
		get_contract: { state: 'estimating', contract: {}, price: null },
	});

	const out = await approve(deps(caller), { taskId: TASK_ID, maxPrice: 100 });

	assert.equal(out.outcome, 'quote');
	assert.equal(caller.countOf('approve_task'), 0);
});

test('insufficient balance on approval becomes topup_required with the task-bound URL', async () => {
	const caller = scriptedCaller({
		get_task: { task_id: TASK_ID, name: 'Research', status: 'LISTENING' },
		get_contract: { state: 'available', contract: {}, price: '$18.00' },
		approve_task: { approved: false, reason: 'insufficient_balance', topup_url: 'https://pay.example/t' },
	});

	const out = await approve(deps(caller), { taskId: TASK_ID, maxPrice: 25 });

	assert.equal(out.outcome, 'topup_required');
	assert.equal(out.topup_url, 'https://pay.example/t');
	assert.equal(out.charged, false);
});

test('fetch_result returns the artifact; rounds exhaust to a resumable pending', async () => {
	const done = scriptedCaller({
		get_task: { task_id: TASK_ID, status: 'CLOSED', next_action: 'fetch_result' },
		get_task_result: { content: '# Report', files: [{ name: 'r.pdf' }], status: 'CLOSED' },
	});
	const ready = await advance(deps(done), { taskId: TASK_ID });
	assert.equal(ready.outcome, 'result');
	assert.equal(ready.content, '# Report');
	assert.equal(ready.files.length, 1);

	const busy = scriptedCaller({
		get_task: { task_id: TASK_ID, status: 'ACTING', next_action: 'awaiting_tendem_work' },
	});
	const pending = await advance(deps(busy), { taskId: TASK_ID, maxRounds: 3 });
	assert.equal(pending.outcome, 'pending');
	assert.equal(busy.countOf('get_task'), 3);
});

// --- reply & waitForResult -----------------------------------------------------

test('reply sends at the live offset, resolves a race once, then advances', async () => {
	let sends = 0;
	const caller = scriptedCaller({
		read_chat: { messages: [], last_seen_offset: 4 },
		send_message: () => {
			sends += 1;
			return sends === 1
				? { response_type: 'race', last_seen_offset: 7 }
				: { response_type: 'sync', last_seen_offset: 8 };
		},
		get_task: { task_id: TASK_ID, status: 'ACTING', next_action: 'awaiting_tendem_work' },
	});

	const out = await reply(deps(caller), { taskId: TASK_ID, reply: 'Berlin, Germany', maxRounds: 1 });

	assert.equal(sends, 2);
	const second = caller.calls.filter((c) => c.name === 'send_message')[1];
	assert.equal(second.args.last_seen_offset, 7);
	assert.equal(out.outcome, 'pending');
});

test('waitForResult never spends even when a quote appears', async () => {
	const caller = scriptedCaller({
		get_task: { task_id: TASK_ID, status: 'LISTENING', next_action: 'await_user_approval' },
		get_contract: { state: 'available', contract: {}, price: '$1.00' },
	});

	const out = await waitForResult(deps(caller), { taskId: TASK_ID });

	assert.equal(out.outcome, 'quote');
	assert.equal(caller.countOf('approve_task'), 0);
});

test('the guard makes approve_task structurally unreachable from check/reply/waitResult', () => {
	const { OPERATION_TOOL_ALLOWLIST } = require('../dist/nodes/Tendem/tools.js');
	for (const key of ['expert:delegate', 'expert:check', 'expert:reply', 'expert:waitResult']) {
		assert.ok(!OPERATION_TOOL_ALLOWLIST[key].includes('approve_task'), `${key} must not spend`);
	}
	assert.ok(OPERATION_TOOL_ALLOWLIST['expert:approve'].includes('approve_task'));
});

// --- node-level: the approval policies through the real execute() -------------

const { TendemExpert } = require('../dist/nodes/TendemExpert/TendemExpert.node.js');
const { mockMcpServer, makeExecuteContext } = require('./harness.js');

async function executeExpert(params, toolHandler) {
	const server = mockMcpServer({ toolHandler });
	const context = makeExecuteContext({ params, requester: server.requester });
	const output = await TendemExpert.prototype.execute.call(context);
	return { output: output[0], server };
}

const QUOTE_WORLD = ({ name }) => {
	if (name === 'get_task') return { task_id: TASK_ID, name: 'Research', status: 'LISTENING' };
	if (name === 'get_contract') return { state: 'available', contract: {}, price: '$18.00' };
	if (name === 'approve_task') return { approved: true };
	throw new Error(`unexpected tool in quote world: ${name}`);
};

test('policy "never" (the default) reports the quote and does not spend', async () => {
	const { output, server } = await executeExpert(
		{ operation: 'approve', taskId: TASK_ID },
		QUOTE_WORLD,
	);
	assert.equal(output[0].json.outcome, 'quote');
	assert.equal(server.countOf('approve_task'), 0);
});

test('policy "underMaxPrice" approves under the cap and refuses over it', async () => {
	const under = await executeExpert(
		{ operation: 'approve', taskId: TASK_ID, approvalPolicy: 'underMaxPrice', maxPrice: 25 },
		QUOTE_WORLD,
	);
	assert.equal(under.output[0].json.outcome, 'approved');

	const over = await executeExpert(
		{ operation: 'approve', taskId: TASK_ID, approvalPolicy: 'underMaxPrice', maxPrice: 5 },
		QUOTE_WORLD,
	);
	assert.equal(over.output[0].json.outcome, 'quote');
	assert.equal(over.server.countOf('approve_task'), 0);
});

test('policy "decision" spends only when the upstream decision is true', async () => {
	const yes = await executeExpert(
		{ operation: 'approve', taskId: TASK_ID, approvalPolicy: 'decision', approveDecision: true },
		QUOTE_WORLD,
	);
	assert.equal(yes.output[0].json.outcome, 'approved');

	const no = await executeExpert(
		{ operation: 'approve', taskId: TASK_ID, approvalPolicy: 'decision', approveDecision: false },
		QUOTE_WORLD,
	);
	assert.equal(no.output[0].json.outcome, 'quote');
	assert.equal(no.server.countOf('approve_task'), 0);
});

test('policy "always" approves the live quote', async () => {
	const { output, server } = await executeExpert(
		{ operation: 'approve', taskId: TASK_ID, approvalPolicy: 'always' },
		QUOTE_WORLD,
	);
	assert.equal(output[0].json.outcome, 'approved');
	assert.equal(server.countOf('approve_task'), 1);
});

test('even policy "always" refuses an unparsable price', async () => {
	const { output, server } = await executeExpert(
		{ operation: 'approve', taskId: TASK_ID, approvalPolicy: 'always' },
		({ name }) => {
			if (name === 'get_task') return { task_id: TASK_ID, status: 'LISTENING' };
			if (name === 'get_contract') return { state: 'estimating', contract: {}, price: null };
			throw new Error(`unexpected: ${name}`);
		},
	);
	assert.equal(output[0].json.outcome, 'quote');
	assert.equal(server.countOf('approve_task'), 0);
});

test('delegate through the node wires chat input into a created task', async () => {
	const { output } = await executeExpert(
		{ operation: 'delegate', request: 'Check the weather in Berlin', taskName: '', conversationId: '', inputBinaryFields: '' },
		({ name }) => {
			if (name === 'create_task') return { task_id: TASK_ID, status: 'ACTING' };
			throw new Error(`unexpected: ${name}`);
		},
	);
	assert.equal(output[0].json.outcome, 'created');
	assert.equal(output[0].json.task_id, TASK_ID);
});

test('delegate auto-uploads chat attachments when Input Binary Fields is empty', async () => {
	const { makeExecuteContext: ctx } = require('./harness.js');
	ctx._puts = [];
	const server = mockMcpServer({
		toolHandler: ({ name, args }) => {
			if (name === 'create_task') return { task_id: TASK_ID, status: 'ACTING' };
			if (name === 'get_file_upload_url')
				return { upload_url: 'https://acc.dfs.core.windows.net/fs/t?sig=s' };
			if (name === 'read_chat') return { messages: [], last_seen_offset: 1 };
			if (name === 'send_message') return { response_type: 'sync', last_seen_offset: 2 };
			throw new Error(`unexpected: ${name}`);
		},
	});
	const context = ctx({
		params: { operation: 'delegate', request: 'Compare pricing in the attached file', taskName: '', conversationId: '', inputBinaryFields: '' },
		items: [{
			json: {},
			binary: {
				data0: { data: Buffer.from('csv,content').toString('base64'), fileName: 'eu-freight-brokers.csv' },
			},
		}],
		requester: server.requester,
	});
	const output = (await TendemExpert.prototype.execute.call(context))[0];

	assert.deepEqual(output[0].json.files_attached, ['eu-freight-brokers.csv']);
	assert.equal(ctx._puts.length, 1);
	assert.equal(
		ctx._puts[0].url,
		'https://acc.blob.core.windows.net/fs/t/eu-freight-brokers.csv?sig=s',
	);
	assert.equal(ctx._puts[0].headers['x-ms-blob-type'], 'BlockBlob');
	const announce = server.toolCalls.find((c) => c.name === 'send_message');
	assert.match(announce.args.text, /eu-freight-brokers\.csv/);
	ctx._puts = undefined;
});
