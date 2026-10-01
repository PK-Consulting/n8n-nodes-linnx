import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class LinnxApi implements ICredentialType {
	name = 'linnxApi';

	displayName = 'Linnx API';

	icon: Icon = { light: 'file:../icons/linnx.svg', dark: 'file:../icons/linnx.dark.svg' };

	documentationUrl = 'https://github.com/PK-Consulting/n8n-nodes-linnx#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'e.g. lnx_...',
			description:
				'Create one at app.linnx.ai under Profile → API keys. It is shown once and cannot be recovered: if you lose it, revoke it and create another. One key reads the one Linnx account that created it.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey.trim()}}',
			},
		},
	};

	// The cheapest valid request on the surface. A 401 here means the key is wrong, revoked or
	// mistyped (the API deliberately does not say which); a 403 means the key is fine and the
	// Linnx subscription is inactive.
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://app.linnx.ai',
			url: '/api/v1/chats',
			qs: { limit: 1 },
			method: 'GET',
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 403,
					message:
						'The key works, but your Linnx subscription is inactive. Reactivate it in Linnx; this same key will work again straight away.',
				},
			},
		],
	};
}
