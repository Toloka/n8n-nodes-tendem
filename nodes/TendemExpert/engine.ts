import type { IDataObject } from 'n8n-workflow';

import { TENDEM_TOOLS, type ToolCaller } from '../Tendem/tools';
import { backoffMs, MIN_SERVER_BLOCK_MS } from '../Tendem/waitForTask';

/**
 * The Tendem delegation state machine, in code instead of prompts.
 *
 * The raw Tendem node exposes the protocol's 11 operations and leaves the choreography — when to
 * poll, when to read the chat, what `await_input` means, which task_id to touch — to the workflow
 * author or an AI agent's system prompt. That choreography is deterministic, so this module owns
 * it. Ported from the `langchain-tendem` runner, which pioneered the shape: the caller (human,
 * workflow, or model) makes judgment calls; the engine makes protocol calls.
 *
 * Every advance loop is bounded and resumable: a `pending` outcome means "call again with the same
 * task_id", never "something is wrong". Money is deliberately its own step:
 * `advance`/`reply`/`waitForResult` NEVER spend — quotes surface as data — and `approve` is the
 * single spending entry point, refusing unless the author's `maxPrice` covers the server's
 * current quote.
 */

/** What a state-machine step resolved to. Stable vocabulary for workflows and agents to branch on. */
export type ExpertOutcome =
	| 'created'
	| 'question'
	| 'quote'
	| 'approved'
	| 'topup_required'
	| 'result'
	| 'pending'
	| 'closed';

export interface ExpertEnvelope extends IDataObject {
	outcome: ExpertOutcome;
	task_id: string;
}

export interface EngineDeps {
	caller: ToolCaller;
	sleep(ms: number): Promise<void>;
	now(): number;
}

export interface AdvanceParams {
	taskId: string;
	/** How many server-side long-poll rounds to spend before returning `pending`. */
	maxRounds?: number;
	waitForChangeSeconds?: number;
}

export const DEFAULT_ADVANCE_ROUNDS = 20;
export const DEFAULT_WAIT_SECONDS = 30;

function readString(obj: IDataObject, key: string): string {
	const value = obj[key];
	return typeof value === 'string' ? value : '';
}

function readNextAction(task: IDataObject): string {
	return readString(task, 'next_action').trim().toLowerCase();
}

/**
 * Parses the server's price — a formatted string like "$40.00" (or already a number) — into a
 * number, or undefined when there is no usable price yet.
 */
export function parsePrice(raw: unknown): number | undefined {
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
	if (typeof raw !== 'string') return undefined;
	const match = raw.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
	if (!match) return undefined;
	const value = Number(match[0]);
	return Number.isFinite(value) ? value : undefined;
}

/** Derives a short task name from the request when the caller did not provide one. */
export function deriveTaskName(request: string): string {
	const words = request.trim().split(/\s+/).slice(0, 8).join(' ');
	const name = words.length > 100 ? `${words.slice(0, 97)}...` : words;
	return name === '' ? 'Delegated task' : name;
}

/** All chat messages, flattened to display text. */
function collectMessages(chat: IDataObject): string {
	return messageTexts(chat).join('\n\n').trim();
}

function messageTexts(chat: IDataObject): string[] {
	const messages = chat.messages;
	if (!Array.isArray(messages)) return [];
	const parts: string[] = [];
	for (const entry of messages) {
		if (!entry || typeof entry !== 'object') continue;
		const text = (entry as IDataObject).text;
		if (typeof text === 'string' && text.trim() !== '') parts.push(text.trim());
	}
	return parts;
}

/**
 * The most recent chat message. On `await_input` Tendem spoke last, so this is what it just said
 * — which is what a caller (or a model) should react to. The full transcript rides along
 * separately: Tendem sometimes answers a trivial brief for free right in the chat, and then the
 * "question" is really the final answer; deciding that is the caller's judgment call, so both
 * views are provided.
 */
function latestMessage(chat: IDataObject): string {
	const parts = messageTexts(chat);
	return parts.length > 0 ? parts[parts.length - 1] : '';
}

async function latestOffset(caller: ToolCaller, taskId: string): Promise<number> {
	const chat = await caller.callTool(TENDEM_TOOLS.READ_CHAT, {
		task_id: taskId,
		from_offset: 0,
	});
	return typeof chat.last_seen_offset === 'number' ? chat.last_seen_offset : 0;
}

/**
 * Sends a chat message at the live offset, re-sending once if Tendem posted new content
 * concurrently. A second race in a row is returned as-is — the conversation has moved and the
 * caller should look before insisting.
 */
export async function sendAtLiveOffset(
	caller: ToolCaller,
	taskId: string,
	text: string,
): Promise<IDataObject> {
	let offset = await latestOffset(caller, taskId);
	let response = await caller.callTool(TENDEM_TOOLS.SEND_MESSAGE, {
		task_id: taskId,
		text,
		last_seen_offset: offset,
	});
	if (response.response_type === 'race') {
		offset =
			typeof response.last_seen_offset === 'number'
				? response.last_seen_offset
				: await latestOffset(caller, taskId);
		response = await caller.callTool(TENDEM_TOOLS.SEND_MESSAGE, {
			task_id: taskId,
			text,
			last_seen_offset: offset,
		});
	}
	return response;
}

export interface DelegateParams {
	request: string;
	taskName?: string;
	conversationId?: string;
	/** Files to attach: name -> raw bytes. Uploaded after create, then announced in the chat. */
	files?: Record<string, Buffer>;
	/** Uploads one file's bytes to its pre-signed URL. Provided by the node (n8n's HTTP helper). */
	putFile?(url: string, data: Buffer): Promise<void>;
}

/** Per-file PUT URL from the folder-level SAS URL: blob host + name before the query string. */
export function blobUploadUrl(uploadUrl: string, name: string): string {
	const [base = '', query = ''] = uploadUrl.split('?');
	const swapped = base.replace('.dfs.core.windows.net', '.blob.core.windows.net');
	return `${swapped.replace(/\/+$/, '')}/${name}${query === '' ? '' : `?${query}`}`;
}

/**
 * Create the task; upload and announce input files when given. Returns `created` with the task_id
 * the rest of the conversation must use. The only non-idempotent step in the module.
 */
export async function delegate(deps: EngineDeps, params: DelegateParams): Promise<ExpertEnvelope> {
	const args: IDataObject = {
		name: params.taskName?.trim() !== '' && params.taskName !== undefined
			? params.taskName
			: deriveTaskName(params.request),
		description: params.request,
	};
	if (params.conversationId !== undefined && params.conversationId !== '') {
		args.conversation_id = params.conversationId;
	}

	const created = await deps.caller.callTool(TENDEM_TOOLS.CREATE_TASK, args);
	const taskId = readString(created, 'task_id');

	const fileNames = Object.keys(params.files ?? {});
	if (fileNames.length > 0 && params.files && params.putFile) {
		const minted = await deps.caller.callTool(TENDEM_TOOLS.GET_FILE_UPLOAD_URL, {
			task_id: taskId,
		});
		const uploadUrl = readString(minted, 'upload_url');
		for (const name of fileNames) {
			await params.putFile(blobUploadUrl(uploadUrl, name), params.files[name]);
		}
		await sendAtLiveOffset(
			deps.caller,
			taskId,
			`I've uploaded ${fileNames.join(', ')} for this task.`,
		);
	}

	return {
		outcome: 'created',
		task_id: taskId,
		status: readString(created, 'status'),
		files_attached: fileNames,
	};
}

/**
 * The heart of the port: poll until the task needs something, then say — as data — what it needs.
 *
 *   await_input          -> `question` with Tendem's LATEST message (full transcript alongside).
 *                           Answer via Reply — or stop: a trivial brief may have been answered
 *                           for free right there, and then the message IS the result.
 *   await_user_approval  -> `quote` with the contract scope and price. This function NEVER
 *                           approves — spending is the Approve operation's job, and only its.
 *   await_user_topup     -> `topup_required` with the task-bound URL; nothing was charged
 *   fetch_result / done  -> `result` with the artifact, or `closed` when nothing is fetchable
 *   rounds exhausted     -> `pending`; call again with the same task_id
 */
export async function advance(deps: EngineDeps, params: AdvanceParams): Promise<ExpertEnvelope> {
	const rounds = Math.max(1, Math.trunc(params.maxRounds ?? DEFAULT_ADVANCE_ROUNDS));
	const waitSeconds = params.waitForChangeSeconds ?? DEFAULT_WAIT_SECONDS;

	let task: IDataObject = {};
	for (let round = 0; round < rounds; round += 1) {
		const startedAt = deps.now();
		task = await deps.caller.callTool(TENDEM_TOOLS.GET_TASK, {
			task_id: params.taskId,
			wait_for_change_seconds: waitSeconds,
		});

		const nextAction = readNextAction(task);

		if (nextAction === 'await_input' || nextAction === 'resolve_race') {
			const chat = await deps.caller.callTool(TENDEM_TOOLS.READ_CHAT, {
				task_id: params.taskId,
				from_offset: 0,
			});
			return {
				outcome: 'question',
				task_id: params.taskId,
				question: latestMessage(chat),
				chat_transcript: collectMessages(chat),
				last_seen_offset: chat.last_seen_offset ?? 0,
			};
		}

		if (nextAction === 'await_user_approval') {
			const contract = await deps.caller.callTool(TENDEM_TOOLS.GET_CONTRACT, {
				task_id: params.taskId,
			});
			const priceRaw = contract.price ?? task.price;
			return {
				outcome: 'quote',
				task_id: params.taskId,
				price: priceRaw ?? null,
				price_value: parsePrice(priceRaw) ?? null,
				contract: contract.contract ?? null,
				charged: false,
			};
		}

		if (nextAction === 'await_user_topup') {
			return {
				outcome: 'topup_required',
				task_id: params.taskId,
				topup_url: readString(task, 'topup_url'),
				price: task.price ?? null,
				charged: false,
			};
		}

		if (nextAction === 'fetch_result' || nextAction === 'done') {
			return await fetchResult(deps, params.taskId, nextAction);
		}

		// awaiting_tendem_work (or an empty envelope): keep waiting, with the same anti-spin
		// backstop the raw node uses.
		if (round < rounds - 1 && deps.now() - startedAt < MIN_SERVER_BLOCK_MS) {
			await deps.sleep(backoffMs(task, waitSeconds));
		}
	}

	return {
		outcome: 'pending',
		task_id: params.taskId,
		status: readString(task, 'status'),
		next_action: readNextAction(task),
	};
}

export interface ApproveParams {
	taskId: string;
	/** Spend cap in USD. The engine approves only when the server's CURRENT quote fits under it. */
	maxPrice: number;
}

/**
 * The only code path in this module that can reach `approve_task`. It re-reads the task and the
 * contract at approval time and refuses unless the cap covers the server's CURRENT quote —
 * approving a price the caller remembered is how stale quotes get bought. Every refusal path
 * charges nothing.
 */
export async function approve(deps: EngineDeps, params: ApproveParams): Promise<ExpertEnvelope> {
	const task = await deps.caller.callTool(TENDEM_TOOLS.GET_TASK, {
		task_id: params.taskId,
		wait_for_change_seconds: 0,
	});
	const contract = await deps.caller.callTool(TENDEM_TOOLS.GET_CONTRACT, {
		task_id: params.taskId,
	});
	const priceRaw = contract.price ?? task.price;
	const price = parsePrice(priceRaw);
	const cap = params.maxPrice;

	if (cap <= 0 || price === undefined || price > cap) {
		return {
			outcome: 'quote',
			task_id: params.taskId,
			price: priceRaw ?? null,
			price_value: price ?? null,
			max_price: Number.isFinite(cap) && cap > 0 ? cap : null,
			over_cap: price !== undefined && cap > 0 && price > cap,
			contract: contract.contract ?? null,
			charged: false,
		};
	}

	const approval = await deps.caller.callTool(TENDEM_TOOLS.APPROVE_TASK, {
		task_id: params.taskId,
		name: readString(task, 'name') || 'Delegated task',
		price: typeof priceRaw === 'string' ? priceRaw : String(priceRaw),
	});

	if (approval.approved !== true) {
		return {
			outcome: 'topup_required',
			task_id: params.taskId,
			topup_url: readString(approval, 'topup_url'),
			price: priceRaw ?? null,
			charged: false,
		};
	}

	return {
		outcome: 'approved',
		task_id: params.taskId,
		price: priceRaw ?? null,
		approved_under_cap: cap,
		contract: contract.contract ?? null,
	};
}

async function fetchResult(
	deps: EngineDeps,
	taskId: string,
	nextAction: string,
): Promise<ExpertEnvelope> {
	const result = await deps.caller.callTool(TENDEM_TOOLS.GET_TASK_RESULT, { task_id: taskId });
	if (result.content === null || result.content === undefined) {
		return {
			outcome: nextAction === 'done' ? 'closed' : 'pending',
			task_id: taskId,
			status: readString(result, 'status'),
		};
	}
	return {
		outcome: 'result',
		task_id: taskId,
		content: result.content,
		files: Array.isArray(result.files) ? result.files : [],
		status: readString(result, 'status'),
	};
}

export interface ReplyParams extends AdvanceParams {
	reply: string;
}

/** Send the answer at the live offset, then keep advancing — one call, both halves of the turn. */
export async function reply(deps: EngineDeps, params: ReplyParams): Promise<ExpertEnvelope> {
	await sendAtLiveOffset(deps.caller, params.taskId, params.reply);
	return await advance(deps, params);
}

/**
 * Block until the verified result is fetchable. Idempotent: `pending` means call again with the
 * same task_id — an interrupted wait loses nothing.
 */
export async function waitForResult(
	deps: EngineDeps,
	params: AdvanceParams,
): Promise<ExpertEnvelope> {
	return await advance(deps, params);
}
