import { z } from 'zod';

import { oidcPromptsGuard } from '@logto/connector-kit';

export const azureADConfigGuard = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  cloudInstance: z.string(),
  tenantId: z.string(),
  prompts: oidcPromptsGuard,
  scopes: z.string().optional(),
  disableEmailSync: z.boolean().optional(),
});

export type AzureADConfig = z.infer<typeof azureADConfigGuard>;

// The cache contains credentials and belongs only in the encrypted token vault.
export const refreshContextGuard = z.object({
  userId: z.string().min(1),
  homeAccountId: z.string().min(1),
  tenantId: z.string().uuid(),
  cache: z.string().min(1),
});

export const userInfoResponseGuard = z.object({
  id: z.string(),
  displayName: z.string().nullish(),
  givenName: z.string().nullish(),
  surname: z.string().nullish(),
  userPrincipalName: z.string().nullish(),
  jobTitle: z.string().nullish(),
  mail: z.string().nullish(),
  mobilePhone: z.string().nullish(),
  officeLocation: z.string().nullish(),
  preferredLanguage: z.string().nullish(),
  businessPhones: z.array(z.string()).nullish(),
});

export type UserInfoResponse = z.infer<typeof userInfoResponseGuard>;

export const authResponseGuard = z.object({
  code: z.string(),
  redirectUri: z.string(),
});
