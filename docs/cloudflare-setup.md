# Cozi on Cloudflare: after setup

To set up your own server, follow the [step-by-step setup guide](https://mjucius.github.io/cozi_mcp/setup/). It has a picture of each screen, what to choose and why, and an option to have an AI assistant do the install.

Your server runs in your own free Cloudflare account, which you own and are responsible for. This is an unofficial project. Cozi doesn't make, recognize or endorse it, and neither does Cloudflare. Other free hosts can run it too, and this guide uses Cloudflare because it's relatively simple to set up.

This page covers what comes after: family members, read-only access, automatic updates, changing your settings, troubleshooting, and removing everything.

## After setup

### Family members

Everyone can connect their own Claude account the same way, using **Add to Claude** on your server's page. They all sign in with the Cozi email in `ALLOWED_EMAIL` and its password.

### Read-only access

Open the connector under **Customize > Connectors** in Claude and set the tools that add, change or delete things to **Blocked**.

### Automatic updates

Your server checks for a new release once a day. It installs one only if the maintainer approved and signed it, and only about 3 days after your server first saw it. The wait leaves time to pull a bad release before anyone installs it. The page at your server's address shows the version and the result of the last check.

- **Turn updates on or off:** In Cloudflare, open **Workers & Pages > calendar-connector > Settings**, click the pencil next to `CF_API_TOKEN`, click **Rotate**, paste a token or type `off`, and click **Deploy**. To get a token, [create one](https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%5D&name=calendar-connector%20updater) in the same Cloudflare account as your server, as in [step 5](https://mjucius.github.io/cozi_mcp/setup/#s5), or the update is refused. Signatures expire after 30 days, so after a long break your server waits for the next release instead of installing an old one.
- **Go back a version:** In the **Deployments** tab, roll back to the version you want. Your server won't reinstall the version you left. It waits for the next release.
- **Don't click the Deploy button again.** That creates a second server at a new address.
- **Don't push to the GitHub repository, if you have one.** Cloudflare would rebuild the version the repository was created with, and your server treats that as a rollback. It stays on that version until the next release.

### Changing your settings

To change the allowed email or the update token, edit `ALLOWED_EMAIL` or `CF_API_TOKEN` under **Workers & Pages > calendar-connector > Settings**, the same way as above.

If you change your Cozi password, Claude loses access within the hour, because every renewal signs in to Cozi again. Open the connector under **Customize > Connectors**, click **Disconnect**, then **Connect**, and sign in with the new password. Everyone else who connected does the same.

## Troubleshooting

### What the update status means

| Status on your server's page | What it means |
|---|---|
| `on, not checked yet` | The token is set. The first check runs within a day. |
| `off (the CF_API_TOKEN secret is missing or set to off)` | Updates are off. Paste a token into `CF_API_TOKEN` to turn them on. |
| `up to date` | You have the latest release. |
| `up to date (latest release not signed yet)` | A release is out but not signed yet. This is normal for a day or so after a release. |
| `2.6.1 found, installing after a 72 h hold` or `2.6.1 waiting for its hold to end` | Your server installs 2.6.1 when the 3 days are up. |
| `updated to 2.6.1` | Installed. |
| `rolled back from 2.6.1; waiting for a newer release` | You rolled back, or a push to the GitHub repository redeployed the original version. Your server waits for the next release. |
| `2.6.1 skipped: its signature is too old; waiting for a newer release` | The release was signed more than 30 days ago. |
| `waiting: open the Worker URL once so it learns its own name` | Open your server's address in a browser. |
| `error: the update token cannot see this server's Cloudflare account` | The token is wrong, was deleted, or was created in a different Cloudflare account. Create a new one in your server's account and paste it into `CF_API_TOKEN`. |
| `error: Cloudflare refused the update (…)` | The token is wrong or was deleted. Create a new one and paste it into `CF_API_TOKEN`. |
| `error: release signature not valid` or `error: worker.js does not match the signed hash` | Your server refused a release that wasn't signed correctly, and installed nothing. Please [open an issue](https://github.com/mjucius/cozi_mcp/issues). |
| any other `error: …` | Usually GitHub or the network. The next daily check tries again. |

### Signing in

- **"That email and password did not work."** The email must be the one in `ALLOWED_EMAIL` (capitals don't matter), and the password must be your current Cozi password.
- **"This server is not set up yet: ALLOWED_EMAIL is missing…"** Add `ALLOWED_EMAIL` under **Settings**.
- **"Too many attempts."** Wait a minute and try again.

### The new repository is nearly empty

If the deploy failed and the new GitHub repository only has a README and `wrangler.jsonc`, Cloudflare's copy failed. Delete that repository and the Worker Cloudflare created, then click the button again.

## Remove everything

1. **Claude:** Under **Customize > Connectors**, open the connector, then **⋯ > Remove**. Everyone who connected removes their own.
2. **Cloudflare:** Delete the Worker under **Workers & Pages > calendar-connector > Settings**, then delete its KV namespace under **Storage & databases > Workers KV**.
3. **Cloudflare:** Under **Manage account > Account API tokens**, delete `calendar-connector updater`, and the build token if the deploy created one.
4. **GitHub, if you used the button:** Delete the repository. If nothing else uses it, uninstall the Cloudflare app under **Settings > Applications**.

## Limits and privacy

- **Cloudflare's free plan** allows 100,000 requests and 1,000 KV writes a day, and 10 ms of CPU time per request. Tool calls measured 2–8 ms and write nothing. A sign-in takes 9–16 ms and 3 writes, and Claude's hourly renewal takes 2 writes. Cloudflare lets the odd request run over 10 ms. If it starts refusing yours, Workers Paid ($5 a month) raises the limits.
- **Your password** is stored in your Cloudflare account, encrypted with a key that only the tokens Claude holds can unlock. Cloudflare runs the code, so whoever controls your Cloudflare account controls your server.
- **Cozi** sees requests coming from Cloudflare, with your `workers.dev` name in a header, and could block servers run this way at any time.
- **The maintainer** never sees your password or your data, but does decide which releases your server installs, unless you turn updates off.
