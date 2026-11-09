# Microsoft Azure AD connector

The Microsoft Azure AD connector provides a succinct way for your application to use Azure’s OAuth 2.0 authentication system.

**Table of contents**

- [Microsoft Azure AD connector](#microsoft-azure-ad-connector)
  - [Set up Microsoft Azure AD in the Azure Portal](#set-up-microsoft-azure-ad-in-the-azure-portal)
  - [Fill in the configuration in Logto](#fill-in-the-configuration-in-logto)
    - [Client ID](#client-id)
    - [Client Secret](#client-secret)
    - [Cloud Instance](#cloud-instance)
    - [Tenant ID](#tenant-id)
    - [Prompts](#prompts)
    - [Scopes](#scopes)
    - [Disable Email Sync](#disable-email-sync)
  - [Token storage and guest identities](#token-storage-and-guest-identities)
  - [References](#references)

## Set up Microsoft Azure AD in the Azure Portal

- Visit the [Azure Portal](https://portal.azure.com/#home) and sign in with your Azure account. You need to have an active subscription to access Microsoft Azure AD.
- Click the **Azure Active Directory** from the services they offer, and click the **App Registrations** from the left menu.
- Click **New Registration** at the top, enter a description, select your **access type** and add your **Redirect URI**, which will redirect the user to the application after logging in. In our case, this will be `${your_logto_endpoint}/callback/${connector_id}`. e.g. `https://foo.logto.app/callback/${connector_id}`. (The `connector_id` can be also found on the top bar of the Logto Admin Console connector details page)
  > You can copy the `Callback URI` in the configuration section.
- Select Web as Platform.

## Fill in the configuration in Logto

| Name             | Type     |
| ---------------- | -------- |
| clientId         | string   |
| clientSecret     | string   |
| tenantId         | string   |
| cloudInstance    | string   |
| prompts          | string[] |
| scopes           | string?  |
| disableEmailSync | boolean? |

### Client ID

You may find the **Application (client) ID** in the **Overview** section of your newly created application in the Azure Portal.

### Client Secret

- In your newly created application, click the **Certificates & Secrets** to get a client secret, and click the **New client secret** from the top.
- Enter a description and an expiration.
- This will only show your client secret once. Fill the **value** to the Logto connector configuration and save it to a secure location.

### Cloud Instance

Usually, it is `https://login.microsoftonline.com/`. See [Azure AD authentication endpoints](https://learn.microsoft.com/en-us/azure/active-directory/develop/authentication-national-cloud#azure-ad-authentication-endpoints) for more information.

### Tenant ID

Logto will use this field to construct the authorization endpoints. This value is dependent on the **access type** you selected when creating the application in the Azure Portal.

- If you select **Accounts in this organizational directory only** for access type then you need to enter your **{TenantID}**. You can find the tenant ID in the **Overview** section of your Azure Active Directory.
- If you select **Accounts in any organizational directory** for access type then you need to enter **organizations**.
- If you select **Accounts in any organizational directory or personal Microsoft accounts** for access type then you need to enter **common**.
- If you select **Personal Microsoft accounts only** for access type then you need to enter **consumers**.

### Prompts

The `prompts` field is an array of strings that specifies the type of user interaction that is required. The string can be one of the following values:

- `prompt=login` forces the user to enter their credentials on that request, negating single-sign on.
- `prompt=none` is the opposite. It ensures that the user isn't presented with any interactive prompt. If the request can't be completed silently by using single-sign on, the Microsoft identity platform returns an `interaction_required` error.
- `prompt=consent` triggers the OAuth consent dialog after the user signs in, asking the user to grant permissions to the app.
- `prompt=select_account` interrupts single sign-on providing account selection experience listing all the accounts either in session or any remembered account or an option to choose to use a different account altogether.

Logto will concatenate the prompts with a space as the value of `prompt` in the authorization URL.

### Scopes

The `scopes` field is a space-separated list of scopes the application needs. The list of scopes can be found in the [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference).

The default scopes are `User.Read`, leave this field empty unless you need other scopes.

### Disable Email Sync

Microsoft Graph returns the user's email address in the `mail` attribute, but reports no verification state for it. `mail` is a directory attribute that an administrator can set to any value, so it is only as trustworthy as the directory it comes from.

Logto syncs that address to the user profile, where it serves as a user identifier. This switch stops it from doing so. It is off by default. Turn it on to leave the raw value in `rawData` only and source the email elsewhere.

Consider turning it on if the connector accepts sign-ins from directories you do not control. This is the case when the app registration's **access type** is anything other than **Accounts in this organizational directory only**, or when **Tenant ID** is set to `organizations`, `common` or `consumers`.

## Token storage and guest identities

With token storage enabled and the Logto secret-vault encryption key configured,
the connector stores its MSAL cache in the encrypted vault. The refresh-token
field is an opaque connector-owned cache, not a raw token for other applications
to exchange. It is never added to social profile data.

Management API machine-to-machine clients can resolve an organizational account
in a requested tenant through `POST /users/:userId/identities/:target/tenant-identity`.
The operation verifies the same Microsoft home account, target tenant, and Graph
user ID. It returns only identity IDs and preserves the original account link.
It uses the existing `User.Read` permission and fails when Microsoft requires
interactive authorization or the stored login has expired. Existing users need
to sign in normally once after token storage is enabled to populate the vault.

## References

- [Web app that signs in users](https://docs.microsoft.com/en-us/azure/active-directory/develop/scenario-web-app-sign-user-overview)
