# Fork maintenance

This fork is based on the upstream `v1.45.0` tag, commit
`94c088f9e4f87ba93df1f72ed20edf16ce364f61`. The maintenance branch is
`agentconnect-1.45`; `master` retains the upstream history.

## Sign-in behavior

When automatic account linking finds a user by their verified primary email,
signing in with a different account from an already linked provider authenticates
that user without replacing the linked identity, its profile, or its stored tokens.
An existing identity match still takes priority over an email match. This does not
enable multiple linked identities for one provider or match arbitrary email aliases.

Explicit Link and Unlink operations continue to change the linked identity.
Signing in with the linked account may refresh its own token. Database row locks
protect token writes during concurrent Link/Unlink and prevent sign-in from replacing
a newly linked account. There are no schema or API-shape changes.

## Build and verification

The Dockerfile builds the checked-out fork source and its lockfile. There is no
build-time patch application or replacement of files inside a running container.
The Fork image workflow runs the verification before publishing an image tagged
with its full source commit. OCI labels identify the source repository, revision,
and MPL-2.0 license. Image publication does not deploy anything.

To run the focused verification against a disposable PostgreSQL 16 database:

```sh
docker build --target verification -t logto-fork:verification .
bash .scripts/fork/verify.sh logto-fork:verification
```

The harness checks the real identity queries, encrypted token records, email
matching, identity precedence, and concurrent Link/Unlink writes. It supplies
already verified social-provider responses; live OAuth sign-in needs separate
validation. Containers are resource-limited and removed on exit.

Only the Fork image workflow is enabled for this fork. Upstream release and
automation workflows remain disabled in repository settings. Upgrades should
start from a new upstream release, retain the focused source changes, and repeat
both database and live OAuth verification before updating a deployment image.
