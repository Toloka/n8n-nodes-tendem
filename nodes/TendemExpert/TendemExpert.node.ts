import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	sleep,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
} from 'n8n-workflow';

import { expertOperations, expertFields } from './descriptions';
import { advance, approve, delegate, reply, waitForResult, type EngineDeps } from './engine';
import {
	McpSession,
	TENDEM_DEFAULT_ENDPOINT,
	type McpHttpRequestOptions,
	type McpHttpResponse,
} from '../Tendem/transport';
import { RetryingToolCaller } from '../Tendem/retry';
import { guardFor, operationKey, type ToolCaller } from '../Tendem/tools';

/**
 * The high-level companion to the raw Tendem node: the delegation choreography lives in this
 * node's code (see ./engine.ts), so neither workflow authors nor AI agents have to teach a model
 * the protocol. Four operations cover the whole lifecycle, every one of them resumable by
 * task_id.
 *
 * `usableAsTool` is the point of this node. The engine's envelopes are the tool results, and money
 * is its own operation: Delegate/Check/Reply/Wait can never spend; Approve is the single spending
 * path and refuses unless the author's Max Price covers the server's CURRENT quote. Max Price 0
 * (the default) refuses everything — quotes stay data.
 */
export class TendemExpert implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Tendem Expert',
		name: 'tendemExpert',
		icon: 'file:../Tendem/tendem.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Involve a vetted human expert via Tendem: delegate work AI cannot reliably finish, drive the scoping conversation, and collect the verified result — with spend capped at a price you set in advance',
		defaults: { name: 'Tendem Expert' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'tendemApi', required: true }],
		properties: [expertOperations, ...expertFields],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('tendemApi');
		const endpoint =
			typeof credentials.endpoint === 'string' && credentials.endpoint.trim() !== ''
				? credentials.endpoint.trim()
				: TENDEM_DEFAULT_ENDPOINT;

		const requester = async (options: McpHttpRequestOptions): Promise<McpHttpResponse> =>
			(await this.helpers.httpRequestWithAuthentication.call(
				this,
				'tendemApi',
				options,
			)) as McpHttpResponse;

		const session = new McpSession(requester, { endpoint });
		const retrying = new RetryingToolCaller(session, { sleep });

		for (let i = 0; i < items.length; i += 1) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				const key = operationKey('expert', operation);
				const guarded: ToolCaller = guardFor(retrying, key);
				const deps: EngineDeps = { caller: guarded, sleep, now: () => Date.now() };

				const payload = await runExpertOperation.call(this, deps, operation, i);

				returnData.push(
					...this.helpers.constructExecutionMetaData(this.helpers.returnJsonArray(payload), {
						itemData: { item: i },
					}),
				);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: error instanceof Error ? error.message : String(error) },
						pairedItem: { item: i },
					});
					continue;
				}
				throw asNodeError.call(this, error, i);
			}
		}

		return [returnData];
	}
}

/**
 * Normalises anything thrown inside the item loop into an n8n node error, so the editor shows the
 * engine's message and the failing item rather than a bare stack trace.
 */
function asNodeError(this: IExecuteFunctions, error: unknown, itemIndex: number): Error {
	if (error instanceof NodeOperationError || error instanceof NodeApiError) return error;
	return new NodeApiError(this.getNode(), error as JsonObject, {
		itemIndex,
		message: error instanceof Error ? error.message : String(error),
	});
}

async function runExpertOperation(
	this: IExecuteFunctions,
	deps: EngineDeps,
	operation: string,
	i: number,
): Promise<IDataObject> {
	switch (operation) {
		case 'delegate': {
			const request = this.getNodeParameter('request', i) as string;
			const taskName = this.getNodeParameter('taskName', i, '') as string;
			const conversationId = this.getNodeParameter('conversationId', i, '') as string;
			const named = (this.getNodeParameter('inputBinaryFields', i, '') as string)
				.split(',')
				.map((name) => name.trim())
				.filter((name) => name !== '');
			// Empty means "everything attached to the item" — the common case, e.g. files added
			// through the chat panel's paperclip, whose property names nobody should have to guess.
			const binaryFields =
				named.length > 0 ? named : Object.keys(this.getInputData()[i].binary ?? {});

			const files: Record<string, Buffer> = {};
			for (const field of binaryFields) {
				const binary = this.helpers.assertBinaryData(i, field);
				const data = await this.helpers.getBinaryDataBuffer(i, field);
				files[binary.fileName ?? field] = data;
			}

			return await delegate(deps, {
				request,
				taskName,
				conversationId,
				files,
				putFile: async (url, data) => {
					await this.helpers.httpRequest({
						method: 'PUT',
						url,
						body: data,
						headers: { 'x-ms-blob-type': 'BlockBlob' },
					});
				},
			});
		}

		case 'check':
			return await advance(deps, {
				taskId: this.getNodeParameter('taskId', i) as string,
				maxRounds: this.getNodeParameter('maxRounds', i, 20) as number,
			});

		case 'reply':
			return await reply(deps, {
				taskId: this.getNodeParameter('taskId', i) as string,
				reply: this.getNodeParameter('replyText', i) as string,
				maxRounds: this.getNodeParameter('maxRounds', i, 20) as number,
			});

		case 'approve': {
			// Every policy collapses to the engine's one primitive — the cap — so the guarantees
			// (single spending path, live quote re-read, unparsable prices refused) hold for all.
			const policy = this.getNodeParameter('approvalPolicy', i, 'never') as string;
			let cap = 0;
			if (policy === 'underMaxPrice') {
				cap = this.getNodeParameter('maxPrice', i, 0) as number;
			} else if (policy === 'decision') {
				cap = (this.getNodeParameter('approveDecision', i, false) as boolean)
					? Number.POSITIVE_INFINITY
					: 0;
			} else if (policy === 'always') {
				cap = Number.POSITIVE_INFINITY;
			}
			return await approve(deps, {
				taskId: this.getNodeParameter('taskId', i) as string,
				maxPrice: cap,
			});
		}

		case 'waitResult':
			return await waitForResult(deps, {
				taskId: this.getNodeParameter('taskId', i) as string,
				maxRounds: this.getNodeParameter('maxRounds', i, 20) as number,
			});

		default:
			throw new NodeOperationError(this.getNode(), `Unsupported Tendem Expert operation "${operation}"`, {
				itemIndex: i,
			});
	}
}
