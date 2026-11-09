import { assert, conditional, deduplicate } from '@silverhand/essentials';
import { got, HTTPError } from 'got';
import path from 'node:path';

import type { AuthenticationResult } from '@azure/msal-node';
import {
  AuthError,
  ConfidentialClientApplication,
  InteractionRequiredAuthError,
} from '@azure/msal-node';
import type {
  GetAuthorizationUri,
  GetConnectorConfig,
  CreateConnector,
  SocialConnector,
  TokenResponse,
} from '@logto/connector-kit';
import {
  ConnectorError,
  ConnectorErrorCodes,
  validateConfig,
  ConnectorType,
  parseJson,
} from '@logto/connector-kit';

import {
  scopes as defaultScopes,
  defaultMetadata,
  defaultTimeout,
  graphAPIEndpoint,
} from './constant.js';
import type { AzureADConfig } from './types.js';
import {
  azureADConfigGuard,
  refreshContextGuard,
  userInfoResponseGuard,
  authResponseGuard,
} from './types.js';

const authorityFor = (config: AzureADConfig, tenantId = config.tenantId) =>
  new URL(path.join(config.cloudInstance, tenantId)).toString();

const createClient = (config: AzureADConfig) =>
  new ConfidentialClientApplication({
    auth: {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      authority: authorityFor(config),
    },
  });

// Provider errors can contain credentials or claims; expose only their stable category.
const tokenRequest = async (request: () => Promise<AuthenticationResult | undefined>) => {
  try {
    const result = await request();
    assert(
      result?.account && result.accessToken,
      new ConnectorError(ConnectorErrorCodes.InvalidResponse)
    );
    return { ...result, account: result.account };
  } catch (error) {
    if (error instanceof ConnectorError) {
      throw error;
    }
    if (
      error instanceof InteractionRequiredAuthError ||
      (error instanceof AuthError && ['invalid_grant', 'no_tokens_found'].includes(error.errorCode))
    ) {
      throw new ConnectorError(ConnectorErrorCodes.SocialAccessTokenInvalid);
    }
    throw new ConnectorError(ConnectorErrorCodes.General);
  }
};

const readProfile = async (accessToken: string) => {
  try {
    const response = await got.get(graphAPIEndpoint, {
      headers: { authorization: `Bearer ${accessToken}` },
      timeout: { request: defaultTimeout },
      retry: { limit: 0 },
    });
    const rawData = parseJson(response.body, ConnectorErrorCodes.InvalidResponse, {});
    const result = userInfoResponseGuard.safeParse(rawData);
    assert(result.success, new ConnectorError(ConnectorErrorCodes.InvalidResponse));
    return { profile: result.data, rawData };
  } catch (error) {
    if (error instanceof ConnectorError) {
      throw error;
    }
    if (error instanceof HTTPError && error.response.statusCode === 401) {
      throw new ConnectorError(ConnectorErrorCodes.SocialAccessTokenInvalid);
    }
    throw new ConnectorError(ConnectorErrorCodes.General);
  }
};

const getAuthorizationUri =
  (getConfig: GetConnectorConfig): GetAuthorizationUri =>
  async ({ state, redirectUri, scope }) => {
    const config = await getConfig(defaultMetadata.id);
    validateConfig(config, azureADConfigGuard);
    const { prompts, scopes } = config;
    return createClient(config).getAuthCodeUrl({
      scopes: scope
        ? scope.split(' ')
        : deduplicate([...defaultScopes, ...(scopes?.split(' ') ?? [])]),
      state,
      redirectUri,
      ...conditional(prompts && prompts.length > 0 && { prompt: prompts.join(' ') }),
    });
  };

const toTokenResponse = (result: AuthenticationResult, refreshToken: string): TokenResponse => ({
  access_token: result.accessToken,
  refresh_token: refreshToken,
  expires_in: Math.max(
    0,
    Math.floor(((result.expiresOn?.getTime() ?? Date.now()) - Date.now()) / 1000)
  ),
  scope: result.scopes.join(' '),
  token_type: result.tokenType,
});

const createAzureAdConnector: CreateConnector<SocialConnector> = async ({ getConfig }) => {
  const readConfig = async () => {
    const config = await getConfig(defaultMetadata.id);
    validateConfig(config, azureADConfigGuard);
    return config;
  };

  const signIn = async (data: unknown) => {
    const callback = authResponseGuard.safeParse(data);
    assert(callback.success, new ConnectorError(ConnectorErrorCodes.InvalidRequestParameters));
    const config = await readConfig();
    const client = createClient(config);
    const result = await tokenRequest(async () =>
      client.acquireTokenByCode({ ...callback.data, scopes: defaultScopes })
    );
    const { profile, rawData } = await readProfile(result.accessToken);
    return {
      userInfo: {
        id: profile.id,
        email: conditional(!config.disableEmailSync && profile.mail),
        name: conditional(profile.displayName),
        rawData,
      },
      result,
      client,
    };
  };

  const acquireForTenant = async (
    refreshToken: string,
    input?: { userId: string; tenantId: string }
  ) => {
    const parsed = refreshContextGuard.safeParse(
      parseJson(refreshToken, ConnectorErrorCodes.SocialAccessTokenInvalid, {})
    );
    assert(parsed.success, new ConnectorError(ConnectorErrorCodes.SocialAccessTokenInvalid));
    const context = parsed.data;
    assert(
      !input || context.userId.toLowerCase() === input.userId.toLowerCase(),
      new ConnectorError(ConnectorErrorCodes.SocialAccessTokenInvalid)
    );
    const tenantId = input?.tenantId.toLowerCase() ?? context.tenantId.toLowerCase();
    assert(
      refreshContextGuard.shape.tenantId.safeParse(tenantId).success,
      new ConnectorError(ConnectorErrorCodes.InvalidRequestParameters)
    );
    const config = await readConfig();
    const client = createClient(config);
    try {
      client.getTokenCache().deserialize(context.cache);
    } catch {
      throw new ConnectorError(ConnectorErrorCodes.SocialAccessTokenInvalid);
    }
    const account = await client.getTokenCache().getAccountByLocalId(context.userId);
    assert(
      account &&
        account.homeAccountId === context.homeAccountId &&
        account.tenantId.toLowerCase() === context.tenantId.toLowerCase(),
      new ConnectorError(ConnectorErrorCodes.SocialAccessTokenInvalid)
    );
    const result = await tokenRequest(async () =>
      client.acquireTokenSilent({
        account,
        authority: authorityFor(config, tenantId),
        scopes: defaultScopes,
        forceRefresh: true,
      })
    );
    assert(
      result.account.homeAccountId === context.homeAccountId &&
        result.account.tenantId.toLowerCase() === tenantId &&
        result.tenantId.toLowerCase() === tenantId,
      new ConnectorError(ConnectorErrorCodes.InvalidResponse)
    );
    const { profile } = await readProfile(result.accessToken);
    assert(
      profile.id.toLowerCase() === result.account.localAccountId.toLowerCase(),
      new ConnectorError(ConnectorErrorCodes.InvalidResponse)
    );
    return {
      result,
      identity: { tenantId, userId: profile.id },
      refreshToken: JSON.stringify({ ...context, cache: client.getTokenCache().serialize() }),
    };
  };

  return {
    metadata: defaultMetadata,
    type: ConnectorType.Social,
    configGuard: azureADConfigGuard,
    getAuthorizationUri: getAuthorizationUri(getConfig),
    getUserInfo: async (data) => {
      const { userInfo } = await signIn(data);
      return userInfo;
    },
    getTokenResponseAndUserInfo: async (data) => {
      const { userInfo, result, client } = await signIn(data);
      assert(
        userInfo.id.toLowerCase() === result.account.localAccountId.toLowerCase() &&
          result.tenantId.toLowerCase() === result.account.tenantId.toLowerCase(),
        new ConnectorError(ConnectorErrorCodes.InvalidResponse)
      );
      const context = refreshContextGuard.parse({
        userId: userInfo.id,
        homeAccountId: result.account.homeAccountId,
        tenantId: result.tenantId,
        cache: client.getTokenCache().serialize(),
      });
      return { userInfo, tokenResponse: toTokenResponse(result, JSON.stringify(context)) };
    },
    getAccessTokenByRefreshToken: async (refreshToken) => {
      const refreshed = await acquireForTenant(refreshToken);
      return toTokenResponse(refreshed.result, refreshed.refreshToken);
    },
    getIdentityForTenant: async (refreshToken, input) => {
      const { identity, refreshToken: updated } = await acquireForTenant(refreshToken, input);
      return { identity, refreshToken: updated };
    },
  };
};

export default createAzureAdConnector;
