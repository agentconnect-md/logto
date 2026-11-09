import nock from 'nock';

import { InteractionRequiredAuthError } from '@azure/msal-node';
import type * as Msal from '@azure/msal-node';
import { vi, describe, beforeEach, afterEach, it, expect } from 'vitest';

import { graphAPIEndpoint } from './constant.js';
import createConnector from './index.js';

const mocks = vi.hoisted(() => ({
  byCode: vi.fn(),
  silent: vi.fn(),
  account: vi.fn(),
  serialize: vi.fn(),
  deserialize: vi.fn(),
}));
vi.mock('@azure/msal-node', async (original) => ({
  ...(await original<typeof Msal>()),
  ConfidentialClientApplication: class {
    acquireTokenByCode = mocks.byCode;
    acquireTokenSilent = mocks.silent;
    getTokenCache() {
      return {
        getAccountByLocalId: mocks.account,
        serialize: mocks.serialize,
        deserialize: mocks.deserialize,
      };
    }
  },
}));

const homeTenant = '00000000-0000-4000-8000-000000000001';
const guestTenant = '00000000-0000-4000-8000-000000000002';
const homeId = '00000000-0000-4000-8000-000000000003';
const guestId = '00000000-0000-4000-8000-000000000004';
const homeAccountId = `${homeId}.${homeTenant}`;
const sourceAccount = { homeAccountId, localAccountId: homeId, tenantId: homeTenant };
const result = {
  accessToken: 'example-access-token',
  scopes: ['User.Read'],
  tokenType: 'Bearer',
  expiresOn: new Date(Date.now() + 3_600_000),
  tenantId: homeTenant,
  account: sourceAccount,
};
const refreshContext = JSON.stringify({
  userId: homeId,
  homeAccountId,
  tenantId: homeTenant,
  cache: 'encrypted-vault-only',
});
const config = {
  clientId: 'example-client',
  clientSecret: 'example-secret',
  cloudInstance: 'https://login.microsoftonline.com',
  tenantId: 'organizations',
  disableEmailSync: true,
};
const connector = async () => createConnector({ getConfig: vi.fn().mockResolvedValue(config) });
const profile = (id: string) => {
  const url = new URL(graphAPIEndpoint);
  return nock(url.origin)
    .get(url.pathname)
    .matchHeader('authorization', 'Bearer example-access-token')
    .reply(200, { id, displayName: 'Alex', mail: 'alex@example.test' });
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.byCode.mockResolvedValue(result);
  mocks.silent.mockResolvedValue({
    ...result,
    tenantId: guestTenant,
    account: { ...sourceAccount, tenantId: guestTenant, localAccountId: guestId },
  });
  mocks.account.mockResolvedValue(sourceAccount);
  mocks.serialize.mockReturnValue('updated-private-cache');
});
afterEach(() => {
  nock.cleanAll();
});

describe('Azure AD native token storage and tenant identity', () => {
  it('keeps the linked identity stable and the MSAL cache out of profile data', async () => {
    profile(homeId);
    const provider = await connector();
    const response = await provider.getTokenResponseAndUserInfo!(
      { code: 'example-code', redirectUri: 'https://login.example.test/callback' },
      vi.fn()
    );
    expect(response.userInfo).toEqual({
      id: homeId,
      name: 'Alex',
      rawData: { id: homeId, displayName: 'Alex', mail: 'alex@example.test' },
    });
    expect(response.tokenResponse).toMatchObject({
      access_token: result.accessToken,
      scope: 'User.Read',
    });
    expect(JSON.parse(response.tokenResponse!.refresh_token!)).toEqual({
      userId: homeId,
      homeAccountId,
      tenantId: homeTenant,
      cache: 'updated-private-cache',
    });
    expect(JSON.stringify(response.userInfo)).not.toContain('cache');
    expect(mocks.byCode).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['User.Read'] }));
  });

  it('preserves the existing user-info contract with optional email sync', async () => {
    profile(homeId);
    const provider = await createConnector({
      getConfig: vi.fn().mockResolvedValue({ ...config, disableEmailSync: false }),
    });
    expect(
      await provider.getUserInfo(
        { code: 'example-code', redirectUri: 'https://login.example.test/callback' },
        vi.fn()
      )
    ).toMatchObject({ id: homeId, email: 'alex@example.test' });
  });

  it('resolves a different guest object using the same home account and only User.Read', async () => {
    profile(guestId);
    const provider = await connector();
    const response = await provider.getIdentityForTenant!(refreshContext, {
      userId: homeId,
      tenantId: guestTenant,
    });
    expect(response.identity).toEqual({ userId: guestId, tenantId: guestTenant });
    expect(mocks.silent).toHaveBeenCalledWith({
      account: sourceAccount,
      authority: `https://login.microsoftonline.com/${guestTenant}`,
      scopes: ['User.Read'],
      forceRefresh: true,
    });
    expect(JSON.parse(response.refreshToken).userId).toBe(homeId);
  });

  it.each(['homeAccount', 'tenant', 'profile', 'source'])(
    'rejects inconsistent %s identity evidence even when mail matches',
    async (fault) => {
      if (fault === 'homeAccount') {
        mocks.silent.mockResolvedValue({
          ...result,
          tenantId: guestTenant,
          account: { ...sourceAccount, tenantId: guestTenant, homeAccountId: 'another-account' },
        });
      }
      if (fault === 'tenant') {
        mocks.silent.mockResolvedValue(result);
      }
      if (fault === 'source') {
        mocks.account.mockResolvedValue({ ...sourceAccount, homeAccountId: 'another-account' });
      }
      if (fault === 'profile') {
        profile(homeId);
      }
      const provider = await connector();
      await expect(
        provider.getIdentityForTenant!(refreshContext, {
          userId: homeId,
          tenantId: guestTenant,
        })
      ).rejects.toThrow();
    }
  );

  it('rejects a relinked source and an invalid tenant without making token requests', async () => {
    const provider = await connector();
    await expect(
      provider.getIdentityForTenant!(refreshContext, { userId: guestId, tenantId: guestTenant })
    ).rejects.toThrow();
    await expect(
      provider.getIdentityForTenant!(refreshContext, {
        userId: homeId,
        tenantId: '../organizations',
      })
    ).rejects.toThrow();
    expect(mocks.silent).not.toHaveBeenCalled();
  });

  it('distinguishes interactive recovery from a provider outage without returning provider error details', async () => {
    const provider = await connector();
    mocks.silent.mockRejectedValue(
      new InteractionRequiredAuthError('interaction_required', 'private-provider-detail')
    );
    await expect(
      provider.getIdentityForTenant!(refreshContext, { userId: homeId, tenantId: guestTenant })
    ).rejects.toMatchObject({ code: 'social_invalid_access_token', data: undefined });
    mocks.silent.mockRejectedValue(new Error('private-provider-detail'));
    await expect(
      provider.getIdentityForTenant!(refreshContext, { userId: homeId, tenantId: guestTenant })
    ).rejects.toMatchObject({ code: 'general', data: undefined });
  });

  it('refreshes normal profile access in the original tenant after guest resolution', async () => {
    mocks.silent.mockResolvedValue(result);
    profile(homeId);
    const provider = await connector();
    const refreshed = await provider.getAccessTokenByRefreshToken!(refreshContext);
    expect(refreshed.access_token).toBe(result.accessToken);
    expect(mocks.silent).toHaveBeenCalledWith(
      expect.objectContaining({ authority: `https://login.microsoftonline.com/${homeTenant}` })
    );
  });

  it('does not include an invalid stored cache in errors', async () => {
    const provider = await connector();
    const invalid = provider.getAccessTokenByRefreshToken!('private-invalid-cache');
    await expect(invalid).rejects.toMatchObject({ code: 'social_invalid_access_token' });
    await expect(invalid).rejects.not.toThrow('private-invalid-cache');
    mocks.deserialize.mockImplementation(() => {
      throw new SyntaxError('private-cache-detail');
    });
    const corrupt = provider.getAccessTokenByRefreshToken!(refreshContext);
    await expect(corrupt).rejects.toMatchObject({ code: 'social_invalid_access_token' });
    await expect(corrupt).rejects.not.toThrow('private-cache-detail');
  });
});
