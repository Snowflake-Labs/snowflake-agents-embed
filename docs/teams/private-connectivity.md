# Teams private connectivity (optional)

Adds the `hybrid` and `privatelink` network modes to an existing install. Complete [install.md](install.md) first.

> **Validation status.**
>
> - **Works (AWS, Azure and GCP):** the `privatelink` edge path. Bot Connector → Worker (`env.privatelink`) → Workers VPC → `cloudflared` → private ingress → container.
> - **Does not work as designed:**
>   - `SNOWFLAKE_HOST_MODE=internal` with the `COMPUTE_POOL` rule: every forwarded user token failed with `395090`. `account` host mode worked ([PL8](#pl8-395090-with-snowflake_host_modeinternal)).
>   - The PAT user's `AWSVPCEID` network policy did not stop the PAT working from the internet ([PL9](#pl9-the-pat-still-works-from-the-internet)). The Azure `AZURELINKID` and GCP `GCPPSCID` equivalents were created and attached but not tested as a PAT control.
>   - `ENFORCE_PRIVATELINK_ACCESS_ONLY` did not block public key-pair or PAT logins on AWS ([§ 7.4](#74-network-sql-accountadmin)). It was deliberately not run on Azure: there is no confirmed admin recovery path there.
> - **Untested:** the Native App path and the self-hosted Node edge.
>
> Do not treat the network policies in this section as the control that keeps the service off the internet until Snowflake confirms the behaviour above. Try the rest on a non-production Business Critical account first, and report what you see, including any error codes.

The default install (`NETWORK_MODE=public`) uses public endpoints for every hop. Two opt-in modes keep Snowflake off the public internet:

- `hybrid`: Snowflake logins are restricted to private connectivity and the compute pool. The public SPCS ingress stays, so the edge is unchanged.
- `privatelink`: the edge reaches the service only through its private ingress.

Both modes are designed for AWS PrivateLink, Azure Private Link and Google Cloud Private Service Connect. `privatelink` is validated on all three (see the status above).

## 7.1 Modes

| Mode                 | Edge → SPCS ingress                                                                                                                | Container → Snowflake                                                                                                                                                               | Policies ([§ 7.4](#74-network-sql-accountadmin))                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public` (default) | Worker, global`fetch` to the public `ingress_url`                                                                               | `SNOWFLAKE_HOST_MODE=account`: the org-account host over the public NAT                                                                                                            | [T7](troubleshooting.md#t7-cloudflare-ip-is-not-allowed-to-access-snowflake) on the PAT user (Cloudflare IPs), [T8](troubleshooting.md#t8-account-network-policy-blocks-the-spcs-to-cortex-call) on `CORTEX_TEAMS_OAUTH` (NAT `/24`) if needed                                    |
| `hybrid`           | Same as public                                                                                                                      | `SNOWFLAKE_HOST_MODE=account` (as in public). `internal` only accepts the SPCS service token, so user tokens get `395090` ([PL8](#pl8-395090-with-snowflake_host_modeinternal)) | Designed:`COMPUTE_POOL` rule on `CORTEX_TEAMS_OAUTH`. With `account` mode keep the T8 NAT policy; T7 kept                                                                                                                                 |
| `privatelink`      | Worker`env.privatelink` through the `SPCS_VPC` Workers VPC binding (cloudflared in your network) to `privatelink_ingress_url` | Same as hybrid:`account` today, so this hop still leaves SPCS over its public NAT                                                                                                  | PAT user limited to your private endpoint IDs (does not currently refuse internet use,[PL9](#pl9-the-pat-still-works-from-the-internet)); T7 policy still the working control; optional `ENFORCE_PRIVATELINK_ACCESS_ONLY` (no observed effect) |

The Teams client, Entra and the Bot Connector are always public. In every mode:

- The personal tab and the bot's messaging endpoint stay on the public edge host (`TAB_BASE_HOST`).
- In `privatelink` the Worker verifies the Bot Connector JWT itself before it relays to the private ingress. The container verifies it again.
- Only the edge's SPCS calls go through the VPC. Entra, JWKS and OBO calls stay on the Worker's normal egress.
- The browser never holds the service PAT or a Snowflake token.

## 7.2 Prerequisites

- **Business Critical** edition (or higher), with private connectivity to the account already in place: AWS PrivateLink, Azure Private Link or GCP Private Service Connect, plus the private DNS for the account URL.
- **A confirmed private login and an admin recovery path**: an ACCOUNTADMIN who can sign in through `privatelink-account-url` from inside the network, and who can do so from where they normally work. This is needed before enforcement ([§ 7.4](#74-network-sql-accountadmin)). A laptop cannot resolve the private hostnames, so if the admin key is only on the laptop, tunnel through a host in the VPC. Tested recipe with AWS Systems Manager (no inbound ports, no sudo; if `brew install --cask session-manager-plugin` needs sudo, use AWS's standalone plugin bundle instead):

  ```bash
  aws ssm start-session --target <instance-id> \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters host=<privatelink-account-url>,portNumber=443,localPortNumber=8443
  # in another shell: TLS is verified against the real hostname, no hosts-file edit
  curl --resolve <privatelink-account-url>:8443:127.0.0.1 \
    -X POST https://<privatelink-account-url>:8443/session/v1/login-request   # 200
  ```

  For a full login, use the Python connector with `host=<privatelink-account-url>`, `port=8443`, and `socket.getaddrinfo` mapped to `127.0.0.1` inside the process. `SELECT CURRENT_IP_ADDRESS()` then returns a VPC address, which proves the login came over private connectivity.

  On Azure this recovery path was **not tested**. `az vm run-command invoke` runs a command on a VM that has no public IP, which is enough to confirm DNS and a `200` from `/session/v1/login-request` from inside the VNet, but it does not give the laptop a tunnel. Use Azure Bastion native-client tunnelling or a VM that holds an ACCOUNTADMIN key before you consider enforcement.

  On GCP this was also **not tested** as a laptop tunnel. IAP SSH needs `roles/iap.tunnelResourceAccessor` (without it: error `4033 'not authorized'`). In-VPC checks that worked without SSH: a startup script (instance metadata) that prints DNS and `login-request` results, read back with `gcloud compute instances get-serial-port-output`. The serial buffer persists across reboots, so give each probe a distinct line prefix and filter for the newest format.
- **Azure Private Link setup** (when the account has no private endpoint yet). Order that worked:

  1. On a new subscription, register the providers first: `az provider register -n Microsoft.Network` and `-n Microsoft.Compute` (wait for `Registered`).
  2. Create the VNet and subnets (`pe`, `vm`), then turn off the private endpoint network policy on the `pe` subnet with `az network vnet subnet update --private-endpoint-network-policies Disabled`. `az network vnet create` rejects that flag.
  3. Read `privatelink-pls-id` from `SELECT SYSTEM$GET_PRIVATELINK_CONFIG();` and create a manual-approval private endpoint to it (`az network private-endpoint create --manual-request true`).
  4. Authorize the endpoint in Snowflake with the **private endpoint's resource ID**, not the subscription ID, and a short-lived Azure token (do not print it):

     ```sql
     SELECT SYSTEM$AUTHORIZE_PRIVATELINK('<private endpoint resource id>', '<az account get-access-token access token>');
     SELECT SYSTEM$GET_PRIVATELINK_AUTHORIZED_ENDPOINTS();   -- type "Azure Endpoint Connection Id", a linkIdentifier
     ```
  5. Create the private DNS zones and records ([§ 7.5](#75-private-dns)).

  Azure Policy can block this on a shared or sandbox subscription (`ResourceGroupQuotaExceeded`, `NetworkActionDeny` on VNet, NSG, route table or public IP actions). Use a subscription where you can create network resources; do not look for ways around a policy deny.
- **GCP Private Service Connect setup** (when the account has no PSC endpoint yet). Order that worked (tested in `europe-west2`):

  1. Enable the Compute Engine and Cloud DNS APIs. Create a custom-mode VPC and a subnet with Private Google Access.
  2. Create a Cloud Router and Cloud NAT. The tunnel VM has no external IP and needs outbound access to GitHub (to install `cloudflared`) and Cloudflare on port 7844.
  3. Reserve an internal address (`gcloud compute addresses create ... --subnet ...`).
  4. Read `privatelink-gcp-service-attachment` from `SELECT SYSTEM$GET_PRIVATELINK_CONFIG();` and create a forwarding rule to it (`gcloud compute forwarding-rules create ... --target-service-attachment <attachment> --address <reserved address> --network ... --subnet ...`). It stays `PENDING` until the next step.
  5. Authorize the **GCP project** (not the endpoint) in Snowflake with the project ID and a short-lived gcloud token. Put the token in a mode-600 temp file and delete it afterwards; do not print it:

     ```sql
     SELECT SYSTEM$AUTHORIZE_PRIVATELINK('<gcp project id>', '<gcloud auth print-access-token>');
     SELECT SYSTEM$GET_PRIVATELINK_AUTHORIZED_ENDPOINTS();   -- type "Gcp Project Id", connectionLimit 10
     ```

     The forwarding rule moves to `ACCEPTED`.
  6. Read the numeric connection ID for the `GCPPSCID` network rule ([§ 7.4](#74-network-sql-accountadmin)): `gcloud compute forwarding-rules describe <rule> --region <region> --format="value(pscConnectionId)"`.
  7. Create the private DNS zones and records ([§ 7.5](#75-private-dns)).

  Org policy and IAM denies (for example a missing `iap.tunnelResourceAccessor` or Secret Manager `setIamPolicy`, see [PL14](#pl14-gcp-secret-manager-iam-denied-for-the-tunnel-vm)) are reported to the project owner, not worked around.
- **For `privatelink` only:**

  - `SELECT SYSTEM$GET_PRIVATELINK_CONFIG();` must return `app-service-privatelink-url` (SPCS private ingress) and `spcs-auth-privatelink-url`. Without them the account has no private SPCS ingress, so use `hybrid`.
  - A host in your network that runs `cloudflared`, uses the private DNS from [§ 7.5](#75-private-dns), and can reach Cloudflare on port 7844 ([PL5](#pl5-cloudflared-cannot-connect-udp-7844)).
  - The `SPCS_VPC` binding needs Workers VPC (beta) on the Cloudflare account.
- **No `executeAsCaller`** in the service spec. The `COMPUTE_POOL` rule does not cover caller's-rights tokens, so `deploy-spcs.sh` refuses `hybrid` and `privatelink` if the spec sets it.

Native App: pick the mode on wizard tab 8 ([Tab 8: Network](native-app.md#b3-streamlit)). It runs the same detection and generates the same SQL as below. Then **Create Service** or **Roll service** on tab 9 applies `service_spec_private.yml`. The Native App path is the least tested: a Native App may reject the spec's `capabilities` block. If **Create Service** fails on it, stay on `public` and report the error.

## 7.3 Path A (standalone SPCS)

> **Use `account` host mode for per-user sign-in.** The internal host (`SNOWFLAKE_HOST_MODE=internal`) accepts only the SPCS-issued service token. Forwarded External OAuth (Entra) user tokens, PATs and key-pair JWTs are rejected there with upstream `401` code `395090` ("Please use OAuth"), whatever the spec or network rules say ([PL8](#pl8-395090-with-snowflake_host_modeinternal)). `account` mode reaches Snowflake over the SPCS public egress NAT, so keep the T8 policy on the integration. `internal` is service-identity-only and opt-in.
>
> **`deploy-spcs.sh` defaults to `account`.** For every `NETWORK_MODE` it writes `SNOWFLAKE_HOST_MODE=account` and `enableCustomCredentials=false`. Set `SPCS_HOST_MODE=internal` in `apps/teams/.env` to opt in to `internal`; the script then warns about `395090`.
>
> **Native App path.** `CONFIG.SET_NETWORK_MODE` still maps `hybrid` and `privatelink` to `service_spec_private.yml` (`internal`) and the wizard still generates the pool policy. That path has the same `395090` problem and is a known follow-up.

1. For `privatelink`, set `NETWORK_MODE=privatelink` in `apps/teams/.env` when you deploy the edge ([§ 7.6](#76-edge-in-privatelink-workers-vpc)). `deploy-spcs.sh` is safe with it set: it keeps `account` host mode.
2. As ACCOUNTADMIN, apply the network SQL ([§ 7.4](#74-network-sql-accountadmin)). Skip the pool rule part; it is only needed for `internal` mode.
3. Service:
   - **New install**: in [`create-dev-service.sql`](../../apps/teams/scripts/create-dev-service.sql) keep `SNOWFLAKE_HOST_MODE: account` and leave the `capabilities` block commented ([install step 5](install.md#2-install-standalone-spcs)). `internal` (set it and uncomment the block) works only for the SPCS service identity; user tokens get `395090`.
   - **Existing service**: confirm the live spec still says `account` after any roll.
4. `bash apps/teams/scripts/deploy-spcs.sh`. With `NETWORK_MODE=hybrid` it prints `network mode: hybrid (SNOWFLAKE_HOST_MODE=account, enableCustomCredentials=false)`. If `docker push` says `unauthorized`, the script built an uppercase registry host: set a lowercase `SNOWFLAKE_REGISTRY_HOST` in `apps/teams/.env`.
5. Leave the `SNOWFLAKE_ACCOUNT_NAME` secret in the org-account form that `bootstrap-dev-spcs.sql` writes. Never use the `.privatelink` host: it does not resolve inside SPCS, and the server warns at boot if it sees one.
6. `hybrid` is done here. Verify chat, streaming and the bot ([install.md § 4](install.md#4-verify)).
7. `privatelink` continues:
   - `SHOW ENDPOINTS IN SERVICE AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS;`. `privatelink_ingress_url` shows "Endpoints provisioning in progress..." for about a minute after the service is `READY`; poll until it appears. Then copy `privatelink_ingress_url` into `apps/teams/.env` as `SPCS_BASE=https://<privatelink_ingress_url>`. Copy it verbatim; do not rebuild it from the wildcard.
   - Add the private DNS records ([§ 7.5](#75-private-dns)).
   - Deploy the edge through the Workers VPC ([§ 7.6](#76-edge-in-privatelink-workers-vpc)).
   - `SPCS_INGRESS_HOST` may stay empty: `generate.mjs` leaves it out of `validDomains`.

To go back to `public`, see [§ 7.8](#78-tear-down-private-connectivity).

## 7.4 Network SQL (ACCOUNTADMIN)

The wizard's Network tab (8c) generates this from the detected cloud and your endpoint IDs. On Path A, copy it and fill in the placeholders. Every statement is idempotent, so re-run the whole block after a change such as a new endpoint ID. The objects live in their own database (`AGENTS_TEAMS_NETWORK.RULES`), so the Native App's `--cascade` teardown never drops a policy that is still attached.

**hybrid and privatelink: container → Snowflake.**

```sql
USE ROLE ACCOUNTADMIN;
CREATE DATABASE IF NOT EXISTS AGENTS_TEAMS_NETWORK;
CREATE SCHEMA IF NOT EXISTS AGENTS_TEAMS_NETWORK.RULES;

-- Container -> Snowflake (internal host mode only, experimental, see 7.3): allow user tokens
-- the service forwards from AGENTS_TEAMS_APP_POOL. In account host mode this rule is unused.
CREATE NETWORK RULE IF NOT EXISTS AGENTS_TEAMS_NETWORK.RULES.AGENTS_TEAMS_POOL_RULE
  TYPE = COMPUTE_POOL MODE = INGRESS VALUE_LIST = ('AGENTS_TEAMS_APP_POOL');
ALTER NETWORK RULE AGENTS_TEAMS_NETWORK.RULES.AGENTS_TEAMS_POOL_RULE SET VALUE_LIST = ('AGENTS_TEAMS_APP_POOL');
CREATE NETWORK POLICY IF NOT EXISTS AGENTS_TEAMS_POOL_POLICY
  ALLOWED_NETWORK_RULE_LIST = (AGENTS_TEAMS_NETWORK.RULES.AGENTS_TEAMS_POOL_RULE);
ALTER NETWORK POLICY AGENTS_TEAMS_POOL_POLICY SET ALLOWED_NETWORK_RULE_LIST = (AGENTS_TEAMS_NETWORK.RULES.AGENTS_TEAMS_POOL_RULE);
ALTER SECURITY INTEGRATION CORTEX_TEAMS_OAUTH SET NETWORK_POLICY = AGENTS_TEAMS_POOL_POLICY;
```

Setting this policy replaces the [T8](troubleshooting.md#t8-account-network-policy-blocks-the-spcs-to-cortex-call) NAT policy on the integration, so only do it when you run `internal` mode. In `account` mode keep the T8 policy. Keep `AGENTS_TEAMS_SPCS_POLICY` if you have one, so switching back is one `ALTER`.

**privatelink only: edge → private ingress.** Use the rule `TYPE` for your cloud:

| Cloud | `TYPE`        | Endpoint ID                                  | Where to find it                                                                                                                                                                                      |
| ----- | --------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS   | `AWSVPCEID`   | `vpce-0123456789abcdef0`                   | VPC console → Endpoints (the endpoint the edge's network uses)                                                                                                                                       |
| Azure | `AZURELINKID` | a number (for example`637547164`)          | `SELECT SYSTEM$GET_PRIVATELINK_AUTHORIZED_ENDPOINTS();`: the row of type "Azure Endpoint Connection Id", its `linkIdentifier` field. Created and attached in testing; not tested as a PAT control |
| GCP   | `GCPPSCID`    | a number (for example`115114074418315274`) | `gcloud compute forwarding-rules describe <rule> --region=<region> --format="value(pscConnectionId)"`. Accepted and attached in testing; not tested as a PAT control                                |

```sql
-- Edge -> SPCS ingress: intended to limit the service PAT to your private endpoint.
-- Observed not to refuse internet use (see below). Keep the Cloudflare IP policy (T7) too.
CREATE NETWORK RULE IF NOT EXISTS AGENTS_TEAMS_NETWORK.RULES.AGENTS_TEAMS_PL_INGRESS_RULE
  TYPE = AWSVPCEID MODE = INGRESS VALUE_LIST = ('<endpoint-id>');   -- AZURELINKID / GCPPSCID on Azure / GCP
ALTER NETWORK RULE AGENTS_TEAMS_NETWORK.RULES.AGENTS_TEAMS_PL_INGRESS_RULE SET VALUE_LIST = ('<endpoint-id>');
CREATE NETWORK POLICY IF NOT EXISTS AGENTS_TEAMS_PL_INGRESS_POLICY
  ALLOWED_NETWORK_RULE_LIST = (AGENTS_TEAMS_NETWORK.RULES.AGENTS_TEAMS_PL_INGRESS_RULE);
ALTER NETWORK POLICY AGENTS_TEAMS_PL_INGRESS_POLICY SET ALLOWED_NETWORK_RULE_LIST = (AGENTS_TEAMS_NETWORK.RULES.AGENTS_TEAMS_PL_INGRESS_RULE);
ALTER USER AGENTS_TEAMS_SVC SET NETWORK_POLICY = AGENTS_TEAMS_PL_INGRESS_POLICY;
```

`AGENTS_TEAMS_SVC` is the user that owns the edge's `SPCS_PAT`; use yours if it differs. The PAT keeps its `ROLE_RESTRICTION`. The endpoint-ID policy is meant to limit where the PAT can be used from, not what it can do. **It did not do that in testing.** With the policy attached (confirmed with `SHOW PARAMETERS LIKE 'NETWORK_POLICY' IN USER AGENTS_TEAMS_SVC`) and the rule correct, the PAT still worked from a laptop on the internet against both the public SPCS ingress and the SQL API. `LOGIN_HISTORY_BY_USER` showed every PAT login as a success with `client_ip` `0.0.0.0`, so no rejection was ever recorded ([PL9](#pl9-the-pat-still-works-from-the-internet)). Treat this policy as defence in depth you cannot yet rely on, and ask Snowflake why it is not enforced before you document it as a control. Protect the PAT instead: `ROLE_RESTRICTION`, short expiry, and the edge session check. Send a direct PAT request to the ingress from inside the network; a success from the internet is the observed behaviour, not a deployment fault.

**User-level policies.** A user's own network policy overrides the integration's policy. Those users get `390422` from the app while everyone else works. This lists them (the view lags by up to about 2 hours):

```sql
SELECT ref_entity_name AS user_name, policy_name
  FROM SNOWFLAKE.ACCOUNT_USAGE.POLICY_REFERENCES
  WHERE policy_kind = 'NETWORK_POLICY' AND ref_entity_domain = 'USER'
    AND ref_entity_name <> 'AGENTS_TEAMS_SVC';
```

For each listed policy, add the pool rule to its allowed list without dropping the user's existing rules:

```sql
ALTER NETWORK POLICY <policy_name> ADD ALLOWED_NETWORK_RULE_LIST = (AGENTS_TEAMS_NETWORK.RULES.AGENTS_TEAMS_POOL_RULE);
```

`ADD` is a preview clause that Snowflake documents for AWS accounts only (not exercised on Azure). On Azure and GCP, read the current list with `DESC NETWORK POLICY <policy_name>;`, then `SET ALLOWED_NETWORK_RULE_LIST = (...)` to that list plus the pool rule.

**Enforcement (optional, privatelink only).** `SYSTEM$ENFORCE_PRIVATELINK_ACCESS_ONLY()` blocks every public login to the account, not just this app's.

> **Warning:** sign in once through the private account URL before you enforce, and confirm you can reach it from where you will run the revert ([§ 7.2](#72-prerequisites)). Enforcing without a working private login locks the account out until Snowflake Support recovers it. Do not enforce without an explicit decision by the account owner.

```sql
-- SELECT SYSTEM$ENFORCE_PRIVATELINK_ACCESS_ONLY();
-- Revert: SELECT SYSTEM$DISABLE_PRIVATELINK_ACCESS_ONLY();
```

Observed on the test account (enforce, then revert):

- The call returned "Successfully enforced Private Link Only Access", but public key-pair logins (`snow sql` over the public host) and public PAT SQL API calls kept working, immediately and after about 70 seconds. It did not behave as a block on public logins for these auth methods.
- The public SPCS ingress with the PAT went from `200` to `500` with an empty body. That is a fault, not a clean refusal.
- A signed-in tab call returned `404 {"code":"thread_not_found"}` while enforcement was on. The container logged no upstream 404, and the same `threads` call with the service PAT returned `200 []` on both hosts. The cause is undetermined ([PL10](#pl10-thread_not_found-404-after-enforcing)).
- `SELECT SYSTEM$DISABLE_PRIVATELINK_ACCESS_ONLY();` restored normal behaviour.

Raise these with Snowflake before you depend on enforcement. Do not enforce in `hybrid`: there the edge still uses the public ingress.

## 7.5 Private DNS

The hosts that need private DNS come from `SELECT SYSTEM$GET_PRIVATELINK_CONFIG();` (the wizard parses it on tab 8a and lists the rows on 8b). Create the records in the zone that the `cloudflared` host and admin workstations resolve through:

| Cloud | Record                                                                                      |
| ----- | ------------------------------------------------------------------------------------------- |
| AWS   | CNAME to the VPC endpoint DNS name, in a Route 53 private hosted zone                       |
| Azure | A record to the private endpoint IP, in an Azure Private DNS zone (A, not CNAME). See below |
| GCP   | A record to the Private Service Connect endpoint IP, in a Cloud DNS private zone            |

| Host                                                                | Needed for                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| the service's`privatelink_ingress_url`                            | privatelink: the edge's`SPCS_BASE`. Add it as an exact record even when the wildcard below covers it |
| `app-service-privatelink-url` (wildcard `*.…`)                 | privatelink: SPCS private ingress                                                                      |
| `app-service-privatelink-url-next`                                | privatelink: SPCS private ingress, newer host form                                                     |
| `spcs-auth-privatelink-url`                                       | privatelink: SPCS ingress authentication                                                               |
| `privatelink-account-url`, `regionless-privatelink-account-url` | admin and user logins over private connectivity                                                        |
| `privatelink-ocsp-url`                                            | certificate revocation (OCSP) checks                                                                   |
| `spcs-registry-privatelink-url`                                   | optional: image push over private connectivity                                                         |

The `privatelink.snowflake.app` zone may already hold a wildcard alias (`*.<region-id>`) that points at a different endpoint. An exact record overrides a wildcard, so always add the exact CNAME for your ingress host, and check the zone for a clashing wildcard first.

Some accounts get the newer `-next` host form for their ingress. Copy `privatelink_ingress_url` from `SHOW ENDPOINTS` verbatim; do not rebuild it from the wildcard. The wildcard's form can differ from the certificate the ingress serves.

**GCP.** Create three Cloud DNS private zones attached to the VPC that holds the `cloudflared` host: `privatelink.snowflakecomputing.com`, `privatelink.snowflake.com` and `privatelink.snowflake.app`. Name each zone for what it holds: zone names cannot be changed, and a wrong name stays until the zone is deleted. Add an A record for every host above in the matching zone, pointing at the reserved PSC address. Tested result from a VM in the VPC: the account, regionless, OCSP and `spcs-auth` hosts and the ingress host all resolved to the PSC address, `POST /session/v1/login-request` with body `{}` returned `200`, and the OCSP host answered `200` on port 80. The existing `*.<region-id>` wildcard A record covered the ingress, but add the exact record anyway.

**Azure.** Create three private DNS zones and link each to the VNet that holds the `cloudflared` host: `privatelink.snowflakecomputing.com`, `privatelink.snowflake.com` and `privatelink.snowflake.app`. Put an A record for every host above in the matching zone, pointing at the private endpoint's IP (`az network private-endpoint show` → network interface → private IP). Tested result from a VM in the VNet: the account, regionless, OCSP and `spcs-auth` hosts and the ingress host all resolved to the private endpoint IP, and `POST /session/v1/login-request` with body `{}` on the private account URL returned `200` (an empty body returns `400`, which is still Snowflake answering). The OCSP host answers on port 80; port 443 shows a certificate name mismatch, which is expected. If the `*.<region-id>` wildcard A record already covers the ingress, still add the exact record.

Check from the `cloudflared` host, with the service PAT in `$SNOWFLAKE_PAT`. The SPCS ingress needs `Authorization: Snowflake Token="<PAT>"`; a `Bearer` header gets a `302` to the login page on every path and looks like a DNS or policy fault. The SQL and Cortex APIs are the opposite: `Authorization: Bearer <PAT>` with `X-Snowflake-Authorization-Token-Type: PROGRAMMATIC_ACCESS_TOKEN`.

```bash
dig +short <privatelink_ingress_url>      # a private address, never a public one
printf 'Authorization: Snowflake Token="%s"\n' "$SNOWFLAKE_PAT" | \
  curl -s -o /dev/null -w '%{http_code}\n' https://<privatelink_ingress_url>/healthz -H @-      # 200
```

## 7.6 Edge in privatelink: Workers VPC

The same Worker serves the tab. Its `env.privatelink` sends only SPCS calls through a Workers VPC service, which rides a Cloudflare Tunnel from a `cloudflared` host in your network. Nothing in your network accepts inbound connections.

1. **Tunnel.** Create a tunnel (Cloudflare dashboard: Zero Trust → Networks → Tunnels, or `cloudflared tunnel create <name>`). Run `cloudflared` on a host that uses the private DNS from [§ 7.5](#75-private-dns). Note the tunnel ID.

   - **Azure host.** Use a small Linux VM in the VNet with no public IP and no inbound NSG rules. It still reaches Cloudflare outbound (port 7844 over QUIC and HTTP/2 both passed in testing). Install and run `cloudflared` as a systemd unit with `az vm run-command`. Pass the tunnel token only as a protected parameter, never in custom data or on the command line:

     ```bash
     az vm run-command create -g <rg> --vm-name <vm> --run-command-name cloudflared-install \
       --script @install-cloudflared.sh --protected-parameters TUNNEL_TOKEN="$TUNNEL_TOKEN"
     ```

     The script reads `$TUNNEL_TOKEN` from its environment. Use `--run-command-name` (not `-n`) and plain `NAME=value`, not JSON. `az vm run-command invoke` has no protected parameters, so use it only for token-free checks. In zsh an unquoted variable holding several arguments is not word-split, so build arrays or quote each argument. The AWS equivalent is an SSM SecureString read at boot.
   - **GCP host.** Use a small Debian 12 VM (`e2-small`) in the VPC with no external IP, a network tag, and its own service account. Cloud NAT gives it outbound access to GitHub and Cloudflare port 7844. A startup script installs `cloudflared` and runs it as a systemd unit.

     `wrangler tunnel create` prints no token. Fetch it from the API with the Wrangler OAuth token (`npx wrangler auth token`) into a mode-600 file, and never print it: `GET https://api.cloudflare.com/client/v4/accounts/<account-id>/cfd_tunnel/<tunnel-id>/token`.

     Deliver the token to the VM through Secret Manager: create the secret, grant `roles/secretmanager.secretAccessor` on that secret to the VM's service account, and have the startup script read it. If your account cannot set the policy (`secretmanager.secrets.setIamPolicy` denied, [PL14](#pl14-gcp-secret-manager-iam-denied-for-the-tunnel-vm)), ask an admin to grant it. The fallback used in testing, with the owner's agreement: put the token in an instance metadata key (`tunnel-token`), have the startup script write it to `/etc/cloudflared-token` (mode 600) and start the unit, then **remove the metadata key straight away** (`gcloud compute instances remove-metadata ... --keys tunnel-token`) and delete the secret. While the key is set, anyone with `compute.instances.get` on the project can read the token.

     Check from the serial console ([§ 7.2](#72-prerequisites)): `cloudflared` is `active`, the ingress host resolves to the PSC address, and an unauthenticated `GET /healthz` returns `302` (the login redirect), which proves the route and TLS without using the PAT.
2. **VPC service.** It points the tunnel at the private ingress host:

   ```bash
   cd packages/teams-edge
   npx wrangler vpc service create agents-teams-spcs --type http \
     --tunnel-id <tunnel-id> --hostname <privatelink_ingress_url>
   ```

   - Pass `--resolver-ips` (your VPC resolver) if the `cloudflared` host's default DNS cannot see the private zone.
   - Leave certificate verification at its default. Never pass `--cert-verification-mode disabled`: it would let any host on the path impersonate the ingress to the PAT.
3. **Binding.** Put the service ID it prints into `apps/teams/.env` as `SPCS_VPC_SERVICE_ID`. `deploy-tab.sh --privatelink` refuses to run without it and renders it into `env.privatelink.vpc_services[0].service_id` of the gitignored `wrangler.local.jsonc`.
4. **Secrets.** `NETWORK_MODE=privatelink` and `SPCS_BASE=https://<privatelink_ingress_url>` in `apps/teams/.env`, then:

   ```bash
   bash apps/teams/scripts/set-edge-secrets.sh
   bash apps/teams/scripts/deploy-tab.sh --privatelink
   ```

   - `set-edge-secrets.sh` refuses an empty `SPCS_BASE` in this mode, and warns if it does not look like a private ingress.
   - `deploy-tab.sh` deploys `--env privatelink` under the same Worker name. Never pass `--env privatelink` to `wrangler tail` or `secret` commands ([Seeing the actual edge Worker error](troubleshooting.md#seeing-the-actual-edge-worker-error)).
5. **Policy.** Apply the privatelink part of [§ 7.4](#74-network-sql-accountadmin) to the PAT user, if you have not already (defence in depth; see the caveat there).
6. **Verify.** This path was validated end to end on AWS PrivateLink (Bot Connector → Worker → `cloudflared` host → private ingress → container, tab chat and a real Teams bot message) and on Azure Private Link and GCP Private Service Connect (same path; edge probes, tab chat and the bot e2e script suite 1).

   - After the first `wrangler deploy` of a new Worker name, `workers.dev` returns Cloudflare error `1042` (a 404) for about 20 seconds while the route propagates. Retry before debugging.
   - The edge probe ([install.md § 4](install.md#4-verify)) through `https://<TAB_BASE_HOST>` returns `401`. The edge answers it without calling SPCS, so it proves only that the Worker started with its binding ([PL6](#pl6-edge-misconfigured-500-in-privatelink)).
   - The tab lists agents and a chat streams. This is the first request that crosses the tunnel.
   - A bot message gets a reply.
   - a direct PAT request to `https://<privatelink_ingress_url>` succeeds from inside the network. From the internet it also succeeded in testing ([PL9](#pl9-the-pat-still-works-from-the-internet)), so do not use a laptop result as evidence either way.

Workers VPC is in beta, so pin the Wrangler version in `packages/teams-edge` and re-run the verify steps after each upgrade. For networks that cannot run a tunnel to Cloudflare, use the self-hosted Node edge in [§ 7.6a](#76a-edge-in-privatelink-self-hosted-node-edge).

## 7.6a Edge in privatelink: self-hosted Node edge

The same edge core runs as a Node container inside your network, with no Cloudflare account. It serves the tab, proxies `/api/*` to the `privatelink_ingress_url` and handles `/token/*`. Teams and the Bot Connector must still reach it over public HTTPS, so put a TLS-terminating load balancer or reverse proxy in front. The edge to SPCS hop stays private.

1. **Build.** From the repo root: `docker build -f apps/teams/edge.Dockerfile -t agents-teams-edge .` The image runs as `node` and bakes in the tab build, so `VITE_SPCS_BASE` must stay empty.
2. **Environment file** (keep it `0600`, never commit it; start from `apps/teams/.env.node-edge.example`). `loadNodeConfig` refuses to start without the first six:

   | Variable                                                                                                   | Value                                                                                                                                                                                                                |
   | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `PUBLIC_ORIGIN`                                                                                          | The browser-facing origin,`https://<TAB_BASE_HOST>`. The edge builds every request URL from it, so the same-origin check never trusts `Host` or `X-Forwarded-Host`. `http` is allowed only for `localhost` |
   | `SPCS_BASE`                                                                                              | `https://<privatelink_ingress_url>`, verbatim from `SHOW ENDPOINTS`                                                                                                                                              |
   | `SPCS_PAT`                                                                                               | The service PAT (same user and`ROLE_RESTRICTION` as the Worker edge)                                                                                                                                               |
   | `EDGE_SESSION_SECRET`, `BOT_LINK_SECRET`                                                               | Random 32+ bytes.`set-edge-secrets.sh` generates them for the Worker; reuse the same values when moving an existing install so sessions and bot links survive                                                      |
   | `BOT_APP_ID`                                                                                             | Required: the Node edge always verifies the Bot Connector JWT                                                                                                                                                        |
   | `AZURE_TENANT_ID`, `OBO_CLIENT_ID`, `OBO_CLIENT_SECRET`, `SNOWFLAKE_SCOPE`, `ENTRA_AUDIENCE_URI` | As for the Worker edge                                                                                                                                                                                               |
   | `TRUSTED_PROXY_HOPS`                                                                                     | How many proxies in front append to`X-Forwarded-For` (default `0`: use the socket address). The edge takes the Nth entry from the right, so the client cannot spoof it                                           |
   | `PORT`, `HOST`, `DATA_DIR`, `TAB_DIST_ROOT`                                                        | Defaults`8080`, `0.0.0.0`, `/data`, `/app/dist`                                                                                                                                                              |
3. **Run, one replica.**

   ```bash
   docker run -d --name teams-edge --restart unless-stopped \
     --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp \
     -v teams-edge-data:/data --env-file edge.env -p 8080:8080 agents-teams-edge
   ```

   - Put `/data` on an encrypted volume (KMS-encrypted EBS, an Azure managed disk with encryption, or a CMEK persistent disk). The bot-link values are already sealed with `BOT_LINK_SECRET`, but the disk should not be readable either.
   - The store is SQLite with an exclusive lock, so a second replica on the same volume fails at startup ([PL7](#pl7-the-node-edge-will-not-start-or-the-link-store-is-locked)). For high availability use the Worker edge.
4. **DNS and TLS.** The container host must use the private DNS from [§ 7.5](#75-private-dns). Point `TAB_BASE_HOST` at the load balancer, then follow the host cutover in [§ 6](install.md#6-pages-to-worker-cutover) (Entra identifier URI, manifest, bot endpoint, `ROLL_SERVER_SERVICE` for CORS), skipping the Cloudflare steps.
5. **Policy.** Apply the privatelink part of [§ 7.4](#74-network-sql-accountadmin). If the container's egress comes through a private endpoint, its endpoint ID goes in the PAT user's rule.
6. **Verify.**

   - `curl https://<TAB_BASE_HOST>/healthz` returns `ok`, and `/config` returns the tab shell, not a 404.
   - The edge probe ([install.md § 4](install.md#4-verify)) returns `401`. As with the Worker, the edge answers it without calling SPCS.
   - A tab chat streams and a bot message gets a reply. These are the first requests that cross the private hop.
   - `docker exec teams-edge stat -c '%a' /data /data/bot-links.sqlite` prints `700` and `600`.

## 7.7 Private connectivity failures

### PL1. `390422` after switching to hybrid or privatelink

**Symptom.** After the roll, the tab shows "Your Snowflake account's network policy is blocking this connection" ([T8](troubleshooting.md#t8-account-network-policy-blocks-the-spcs-to-cortex-call) banner). The container log has `390422`. It happens for every user, or only for some.

**Cause.**

- **Every user:** the container now calls the internal host, but `CORTEX_TEAMS_OAUTH` has no `COMPUTE_POOL` rule. Either the policy is missing, or it is still the T8 NAT `/24`, which cannot match internal traffic.
- **Some users:** those users have their own network policy, which overrides the integration's.
- A `public` spec that still carries `enableCustomCredentials: false` with `SNOWFLAKE_HOST_MODE=internal` fails the same way.

**Fix.**

- `DESC SECURITY INTEGRATION CORTEX_TEAMS_OAUTH;` should show `NETWORK_POLICY` = `AGENTS_TEAMS_POOL_POLICY`. If not, apply [§ 7.4](#74-network-sql-accountadmin).
- For individual users, run the `POLICY_REFERENCES` query and add the pool rule to each listed policy.
- On Path A, confirm the live spec (`DESCRIBE SERVICE`) has `SNOWFLAKE_HOST_MODE: internal` and `enableCustomCredentials: true` together. If the error is `395090` instead of `390422`, see [PL8](#pl8-395090-with-snowflake_host_modeinternal): `internal` mode itself is the problem.

**Verify.** Start a new chat; `/api/agent/run` streams.

### PL2. `NXDOMAIN` for a privatelink host

**Symptom.** Either of these:

- The container log shows `ENOTFOUND` / `NXDOMAIN` for a `*.privatelink.snowflakecomputing.com` host.
- `cloudflared` or `dig` on the tunnel host cannot resolve `privatelink_ingress_url`.

**Cause.**

- **Inside SPCS:** `SNOWFLAKE_ACCOUNT` (the `SNOWFLAKE_ACCOUNT_NAME` secret) was set to the private account URL. That host does not resolve inside SPCS. In internal mode the container uses the injected `SNOWFLAKE_HOST` instead.
- **On the tunnel host:** the private zone is missing the record, or that host does not use the zone.

**Fix.**

- **SPCS:** put the org-account form back (`<org>-<account>`, as `bootstrap-dev-spcs.sql` writes it), then roll.
- **Tunnel host:** add the exact `privatelink_ingress_url` record ([§ 7.5](#75-private-dns)) and associate the zone with the host's VPC or VNet. Alternatively, pass `--resolver-ips` on the VPC service.

**Verify.** `dig +short <privatelink_ingress_url>` returns a private address.

### PL3. The private ingress rejects the edge (401 or 403)

**Symptom.** In `privatelink`, the tab's `/api/*` requests fail at the ingress with either of these:

- `401` "Incoming request with IP/Token … is not allowed": the network policy check.
- `403 Insufficient privileges to use <ingress>`: the endpoint grant check.

The edge probe in [install.md § 4](install.md#4-verify) still returns `401 {"error":"Unauthorized"}`, because it never reaches the ingress.

**Cause.** For the `401`, one of three:

- The PAT user's policy does not list the endpoint the tunnel host actually uses. A second VPC endpoint or another region has a different ID. (In testing the policy was never enforced, so this cause may not fire on your account; see [PL9](#pl9-the-pat-still-works-from-the-internet).)
- Using `Authorization: Bearer` against the ingress when testing by hand. The ingress needs `Snowflake Token="<PAT>"` and answers `Bearer` with a `302` to login.
- The user still has the Cloudflare IP policy (T7), which a private-endpoint request cannot match.
- The Worker still runs the public env, or `SPCS_BASE` is still the public ingress. The request then arrives from a Cloudflare IP, which the endpoint-ID policy rejects.

For the `403`, the PAT user lacks `ALL_ENDPOINTS_USAGE` / `APP_PUBLIC` ([T6](troubleshooting.md#t6-api-fails-at-the-edge-or-the-ingress)).

**Fix.**

- `SHOW PARAMETERS LIKE 'NETWORK_POLICY' IN USER <pat-user>;` should name `AGENTS_TEAMS_PL_INGRESS_POLICY`. Check its rule's `VALUE_LIST` against the endpoint ID on the tunnel host's network, then re-run [§ 7.4](#74-network-sql-accountadmin) with the right IDs.
- Check that `apps/teams/.env` `SPCS_BASE` is `https://<privatelink_ingress_url>`, then run `set-edge-secrets.sh` and `deploy-tab.sh --privatelink`.
- For the `403`, apply the grant in [T6](troubleshooting.md#t6-api-fails-at-the-edge-or-the-ingress).

**Verify.**

- Reload the tab: the agent list loads.
- From the tunnel host, a direct PAT request to `https://<privatelink_ingress_url>` succeeds.

### PL4. Northstar host: audience or certificate mismatch

**Symptom.** Either of these:

- The edge (or `curl` from the tunnel host) fails TLS with a certificate name mismatch on the private ingress.
- The ingress rejects the PAT with an audience error, although the same PAT works on the public ingress.

**Cause.**

- **Certificate:** the host was rebuilt from `app-service-privatelink-url`, and the wildcard's form does not match the certificate's name.
- **Audience:** on the newer `-next` ingress, the token audience can differ from the host form you called.

**Fix.**

- Use `privatelink_ingress_url` from `SHOW ENDPOINTS` verbatim in `SPCS_BASE`, the VPC service `--hostname`, and the DNS record.
- If the audience error persists with the verbatim host, it is the open Snowflake issue. Stay on `hybrid` until it is fixed.
- Do not work around either error by disabling certificate verification.

**Verify.** `curl https://<privatelink_ingress_url>/healthz` from the tunnel host completes TLS without `-k`.

### PL5. cloudflared cannot connect (UDP 7844)

**Symptom.** Either of these:

- `cloudflared` logs repeated `failed to dial to edge with quic` or `Unable to establish connection`.
- The dashboard shows the tunnel as down; edge calls to SPCS time out or return `502`.

**Cause.** The host's egress blocks Cloudflare's tunnel port. `cloudflared` uses QUIC on UDP 7844 and falls back to HTTP/2 on TCP 7844.

**Fix.**

- Allow outbound UDP and TCP 7844 from the `cloudflared` host to Cloudflare.
- If UDP cannot be opened, run `cloudflared tunnel run --protocol http2 <tunnel>` so it uses TCP only.
- No inbound rule is needed.

**Verify.** The tunnel shows **Healthy** and the [§ 7.6](#76-edge-in-privatelink-workers-vpc) verify steps pass.

### PL6. `Edge misconfigured` 500 in privatelink

**Symptom.** The tab loads, but every `/api/*` and `/token/*` call returns `500 {"error":"Edge misconfigured"}`. `wrangler tail` shows `Edge misconfigured: SPCS_UPSTREAM=vpc but the SPCS_VPC binding is missing`, or `Unknown SPCS_UPSTREAM`.

**Cause.** The privatelink env deployed without its VPC binding. Usually the deploy bypassed `deploy-tab.sh` (a bare `wrangler deploy` uses the template with placeholder ids), or `SPCS_VPC_SERVICE_ID` was wrong. By design the Worker fails closed: it proxies nothing rather than send the PAT over the public internet. A `500 {"error":"Proxy misconfigured"}` on `/api/bot/messages` is the related check: in privatelink the Worker must verify bot requests, so it needs the `BOT_APP_ID` secret.

**Fix.**

- Restore `env.privatelink.vpc_services` with the real service ID ([§ 7.6](#76-edge-in-privatelink-workers-vpc) step 3), and redeploy with `deploy-tab.sh --privatelink`.
- For the bot, re-run `set-edge-secrets.sh` with `BOT_APP_ID` set.

**Verify.** `wrangler tail <worker-name>` shows no `Edge misconfigured` lines and the edge probe ([install.md § 4](install.md#4-verify)) returns `401`. The probe proves the binding is present, not that the tunnel works; a tab chat proves that ([§ 7.6](#76-edge-in-privatelink-workers-vpc)).

### PL7. The Node edge will not start, or the link store is locked

**Symptom.** The container exits at boot. The log says one of: `Bot-link database … is locked by another process`, `Data directory … has mode 7xx` or `must not be group or world accessible`, `is owned by uid …`, `Refusing to run the bot-link store as root`, or `Missing required environment: …`.

**Cause.** The store protects the sealed bot links, so it refuses to start rather than repair a weak setup.

- *Locked.* A second replica, or an old container still running, holds the SQLite lock on the same volume.
- *Mode or owner.* The volume was created by another user or with a loose mode.
- *Root.* The container was started with `--user 0`.
- *Missing environment.* A required variable is unset ([§ 7.6a](#76a-edge-in-privatelink-self-hosted-node-edge) step 2).

**Fix.**

- Run exactly one replica: `docker ps` for a stale container, then stop it. Do not delete the `-wal` or `-shm` files.
- Fix the volume, as the volume's owner: `chown node:node` and `chmod 700` on the directory, `chmod 600` on `bot-links.sqlite`. Never loosen the checks.
- Remove `--user`, so the image's `node` user runs.

**Verify.** `docker logs teams-edge` ends with `teams-edge listening on …`, and `/healthz` returns `ok`.

### PL8. `395090` with `SNOWFLAKE_HOST_MODE=internal`

**Symptom.** In `hybrid` or `privatelink`, every call from the container to Snowflake fails with upstream `401` code `395090`: "Error connecting to Snowflake via Snowpark Container Services. Please use OAuth". The tab shows `agent_forbidden`. There is no `390422`.

**Cause.** Snowflake design, not a misconfiguration. Inside SPCS the injected `SNOWFLAKE_HOST` resolves to the SPCS-internal endpoint, which marks the request as coming from SPCS and accepts only the SPCS-issued token from `/snowflake/session/token`. Any other credential (forwarded External OAuth, PAT, key-pair JWT) gets `395090`, and the "Please use OAuth" text is misleading. The container sends `Authorization: Bearer <Entra token>` with `X-Snowflake-Authorization-Token-Type: OAUTH`, so no header change fixes it, and `enableCustomCredentials` is documented only for the Python connector and ODBC. Caller's rights does not help: it identifies the user who authenticated to the ingress, which here is the Worker's service PAT. It reproduced on two accounts; changing only `SNOWFLAKE_HOST_MODE` to `account` fixed it, and tab chat and a real Teams bot message then worked. The server now reports this as code `host_mode_rejects_user_token` and warns at boot when `internal` is combined with `production` or `local-oauth`. The 395090 path is reasoned from Snowflake's internal tickets and our two reproductions; the direct SPCS-token-200 versus Entra-token-395090 comparison was not run.

**Open question for Snowflake.** Is there a supported private egress path from SPCS to the account (for example the account's own PrivateLink host) that accepts non-SPCS credentials? Until there is, per-user identity means the container's Snowflake calls leave over SPCS public egress.

**Fix.** Set `SNOWFLAKE_HOST_MODE: account` in the live spec (`ALTER SERVICE ... FROM SPECIFICATION`, or edit `create-dev-service.sql` before a new create), keep the T8 policy on the integration, and remove `SPCS_HOST_MODE=internal` from `apps/teams/.env` if set ([§ 7.3](#73-path-a-standalone-spcs)).

**Verify.** A new chat streams, and the container log has no `395090`.

### PL9. The PAT still works from the internet

**Symptom.** From a laptop, a direct PAT request to the public ingress succeeds, and the SQL API accepts the PAT, although `AGENTS_TEAMS_PL_INGRESS_POLICY` is attached to the PAT user.

**Cause.** Not identified. `SHOW PARAMETERS` shows the policy and the `AWSVPCEID` rule is correct, but `LOGIN_HISTORY_BY_USER` records `client_ip` as `0.0.0.0` for these PAT logins and none was rejected. So the user-level endpoint-ID policy did not restrict the PAT on this account.

**Fix.** There is none yet. Do not rely on the policy as the control that keeps the PAT off the internet. Keep `ROLE_RESTRICTION` and a short expiry, keep the T7 policy as well if your edge has stable egress IPs, and ask Snowflake whether `AWSVPCEID` rules apply to PAT logins and to SPCS ingress.

**Verify.** Not testable from the internet side. Check `LOGIN_HISTORY_BY_USER` for rejected logins after you change anything.

### PL10. `thread_not_found` 404 after enforcing

**Symptom.** After `SYSTEM$ENFORCE_PRIVATELINK_ACCESS_ONLY()`, the tab's `GET /api/threads?page_size=20` returns `404 {"code":"thread_not_found"}`.

**Cause.** Undetermined. `codeForUpstreamStatus` in `packages/cortex-server/src/http/upstream-error.ts` maps any upstream 404 to `thread_not_found`, but the container logged no `Upstream 404`. The same endpoint with the service PAT returned `200 []` while enforcement was on, so the endpoint was reachable. It might be enforcement or the signed-in user's Snowflake user and role.

**Fix.** Run `SELECT SYSTEM$DISABLE_PRIVATELINK_ACCESS_ONLY();` (through the admin recovery path in [§ 7.2](#72-prerequisites) if you need it) and retry. If it still fails, check the user's role and the `SNOWFLAKE_SCOPE`.

**Verify.** The tab lists threads again.

### PL11. Account network policy blocks the container's egress (`account` host mode)

**Symptom.** The tab shows "Your Snowflake account's network policy is blocking this connection" ([T8](troubleshooting.md#t8-account-network-policy-blocks-the-spcs-to-cortex-call) banner) and the agent selector is empty, but the PAT user works. Seen on Azure and GCP accounts with an account-wide IP allow-list.

**Cause.** In `account` host mode the container reaches Snowflake over the public internet from an SPCS egress pool, not one address (three addresses in one `/24` appeared on Azure; `35.246.9.223` on GCP `europe-west2`, so allow `35.246.9.0/24` there). The range differs by cloud and region: read it from your own blocked rows. `LOGIN_HISTORY` shows the signed-in user from the SPCS address with `INCOMING_REQUEST_BLOCKED`, while the PAT user, whose own policy applies, succeeds.

**Fix.** Allow the SPCS egress range for the Teams users or for `CORTEX_TEAMS_OAUTH`, not for the whole account. Find the range from the blocked rows, allow the whole `/24`, and keep the user-level or integration-level policy narrow:

```sql
SELECT event_timestamp, user_name, client_ip, error_message
  FROM TABLE(SNOWFLAKE.INFORMATION_SCHEMA.LOGIN_HISTORY(TIME_RANGE_START => DATEADD('hour', -1, CURRENT_TIMESTAMP())))
  WHERE error_message ILIKE '%INCOMING_REQUEST_BLOCKED%';
```

**Verify.** The blocked rows stop and the tab lists agents. The account-wide policy itself is unchanged.

### PL12. The agent selector is empty although agents exist

**Symptom.** `GET /api/agents` returns `[]`. `SHOW AGENTS` run by hand as the same user lists them.

**Cause.** `runShowAgents` in `packages/cortex-server/src/snowflake/list-agents.ts` returns `[]` for any non-OK response, so a blocked login ([PL11](#pl11-account-network-policy-blocks-the-containers-egress-account-host-mode)), a missing grant or a missing warehouse looks like "no agents". This is a known code gap, not a configuration choice.

**Fix.** Check `LOGIN_HISTORY` and the container log (`agents-teams-app`) before changing any grant. If the PAT user's `SHOW AGENTS` returns `200` with no rows, the role lacks `USAGE ON AGENT`. the sample-agent grants script did not grant it (seen on GCP):

```sql
GRANT USAGE ON AGENT <DB>.<SCHEMA>.<AGENT_NAME> TO ROLE AGENTS_TEAMS_USER;
```

**Verify.** The selector lists the agents once the real cause is fixed.

### PL13. The default agent needs a warehouse the account does not have

**Symptom.** An agent run fails on a fresh account, and the agent references `CORTEX_WH`.

**Cause.** Cortex agents run on the user's `DEFAULT_ROLE`, which needs a usable warehouse. An agent that references a warehouse such as `CORTEX_WH` fails on a new trial account, which does not have one.

**Fix.** Create the warehouse (or point the agent at one that exists) and grant `USAGE` on it to the Teams role. Set the user's `DEFAULT_WAREHOUSE`.

**Verify.** A chat turn returns a table or text instead of an agent run error.

### PL14. GCP Secret Manager IAM denied for the tunnel VM

**Symptom.** `gcloud secrets add-iam-policy-binding` fails with `403 secretmanager.secrets.setIamPolicy` denied, so the VM's service account cannot read the tunnel-token secret and `cloudflared` never starts.

**Cause.** Your gcloud identity can create secrets but not set their IAM policy. This is an organisation permission, not a fault in the setup.

**Fix.** Ask a project admin to grant `roles/secretmanager.secretAccessor` on that one secret to the VM's service account. Do not widen IAM at project level yourself. If the account owner agrees to a short-lived fallback, pass the token in an instance metadata key that the startup script copies to a mode-600 file, then remove the key and delete the secret ([§ 7.6](#76-edge-in-privatelink-workers-vpc)).

**Verify.** `cloudflared` is `active` on the VM (serial console), the tunnel shows connections in Cloudflare, and `gcloud compute instances describe <vm> --format="value(metadata.items[].key)"` no longer lists `tunnel-token`.

### Other things seen on a new or trial account

These are not PrivateLink faults, but a fresh account hits them in the same session:

- Chat fails with "Access denied for trial accounts" until Cortex agents are enabled on the account.
- Title generation logs Cortex `403` code `003001` ("This account is not allowed to access this endpoint") on a trial account. Chat itself works.
- `[bot] hydration failed … will retry next turn`: the bot reads `SNOWFLAKE_INTELLIGENCE.AGENTS.COWORK_BOT_STATE`, and no setup script creates it. It is non-fatal, but per-user bot state is lost on restart.
- `snow sql -f` echoes each statement before the JSON, which breaks JSON parsing. Use `snow sql -q "<sql>" --format json`.
- The service's container is named `agents-teams-app` in `SYSTEM$GET_SERVICE_LOGS`. The valid login view is `SNOWFLAKE.INFORMATION_SCHEMA.LOGIN_HISTORY`.
- A laptop IP outside the account's network policy cannot run `snow` at all (login fails with `250001`). Connect the VPN first, and do the non-Snowflake steps first when that happens mid-teardown.
- `deploy-spcs.sh` builds an uppercase registry host, so `docker push` says `unauthorized`. Set a lowercase `SNOWFLAKE_REGISTRY_HOST`.
- `fill-dev-secrets.sh` aborts while `TEAMS_APP_ID` is blank; generate it first.
- `set-edge-secrets.sh` appends new `EDGE_SESSION_SECRET` and `BOT_LINK_SECRET` lines even when blank placeholders exist, leaving duplicates. Delete the blank ones. If `apps/teams/.env` lacks a trailing newline, a plain `echo >>` glues the new line onto the last one: append with `printf '\n...'`.

## 7.8 Tear down private connectivity

To go back to `public`, keep the service and undo the policies in the order below. Each step changes one hop. Chat fails for that hop between the two halves of a step, so run each step without a break.

If you enforced private-only access, revert it before step 1, because the `public` container calls Snowflake over the public NAT: `SELECT SYSTEM$DISABLE_PRIVATELINK_ACCESS_ONLY();`.

1. **Container.**

   - Switch the mode back. Native App: on wizard tab 8 pick **public**, then **Roll service** on tab 9. Path A: set `NETWORK_MODE=public` and run `deploy-spcs.sh`.
   - Then, as ACCOUNTADMIN, put the integration back on its public policy ([T8](troubleshooting.md#t8-account-network-policy-blocks-the-spcs-to-cortex-call)), or unset it:

     ```sql
     ALTER SECURITY INTEGRATION CORTEX_TEAMS_OAUTH SET NETWORK_POLICY = AGENTS_TEAMS_SPCS_POLICY;   -- or UNSET NETWORK_POLICY
     ```
2. **Edge** (privatelink only).

   - Put the PAT user back on the Cloudflare IP policy ([T7](troubleshooting.md#t7-cloudflare-ip-is-not-allowed-to-access-snowflake)): `ALTER USER AGENTS_TEAMS_SVC SET NETWORK_POLICY = AGENTS_TEAMS_INGRESS_POLICY;`.
   - Set `SPCS_BASE` back to the public `ingress_url` (or remove it, so `set-edge-secrets.sh` uses `SPCS_INGRESS_HOST`) and `NETWORK_MODE=public`. Then run `set-edge-secrets.sh` and `deploy-tab.sh --public`.
3. **Drop the private objects.** Remove the pool rule first from any user-level policy you added it to in [§ 7.4](#74-network-sql-accountadmin) (`REMOVE ALLOWED_NETWORK_RULE_LIST`, or `SET` without it). Then:

   ```sql
   DROP NETWORK POLICY IF EXISTS AGENTS_TEAMS_POOL_POLICY;
   DROP NETWORK POLICY IF EXISTS AGENTS_TEAMS_PL_INGRESS_POLICY;
   DROP DATABASE IF EXISTS AGENTS_TEAMS_NETWORK;
   ```

   Snowflake refuses to drop a policy that is still attached to a user or integration, so an error here means a step above was skipped.
4. **Cloudflare and DNS.**

   - Node edge: stop and remove the container, then the `/data` volume once no bot links are needed.
   - Workers VPC: delete the VPC service with `npx wrangler vpc service delete <service-id>` from `packages/teams-edge`.
   - Delete the tunnel, and stop `cloudflared`.
   - Remove the SPCS records from the private zone. Keep the account URL records if other clients use private connectivity.
5. **A throwaway test install.** The order that worked (AWS steps first, then the Azure variant below):

   - Bot: point the Bot Service messaging endpoint back at the production Worker or Pages URL, and restore `apps/teams/.env` (including `BOT_LINKS_KV_ID`).
   - Entra: remove the test identifier URI. `az ad app update --identifier-uris` replaces the whole set, so pass the URIs you want to keep.
   - Cloudflare: delete the test Worker, the VPC service, then the tunnel.
   - AWS: terminate the `cloudflared` instance, delete its SSM parameter, then remove the Route 53 records for the ingress host.
   - Snowflake: unset the integration and user policies, then drop the service, compute pool, external access integration, `CORTEX_TEAMS_OAUTH`, the service and test users, both network policies, `AGENTS_TEAMS_NETWORK` and `AGENTS_TEAMS_APP_DB`, and the role. `SHOW PARAMETERS ... IN INTEGRATION` is not supported (`002041`); use `DESC SECURITY INTEGRATION`.
   - Teams: remove the sideloaded test app.

   **Azure variant.** Same groups, with these differences:

   - **Revoke before you delete the endpoint.** Run `SELECT SYSTEM$REVOKE_PRIVATELINK('<private endpoint resource id>', '<az access token>');` while the private endpoint still exists. After the endpoint is deleted the call fails with `502012` ("Endpoint Id is not found") for the endpoint ID and `502004` ("Endpoint Id is invalid") for the subscription ID, and the endpoint stays listed by `SYSTEM$GET_PRIVATELINK_AUTHORIZED_ENDPOINTS()` with an empty `linkIdentifier`. The leftover entry is inert; ask Snowflake support if it must be cleared.
   - **Delete the resource group, then the tunnel.** `az group delete --name <rg> --yes` then `az group wait --name <rg> --deleted` removes the VM, endpoint, DNS zones and VNet and stops `cloudflared`. `wrangler tunnel delete` fails with Cloudflare error `1022` ("active connections") while `cloudflared` is still connected, so delete the Worker, the VPC service (`wrangler vpc service delete <id>`), the resource group and only then the tunnel. Pass `--name` to every `wrangler` command, never `--env privatelink`.
   - **Entra and bot.** Delete the throwaway Azure Bot (find its resource group with `az bot show`) and its Entra app by display name. Check the app ID is not the live bot's before deleting.
   - **Local.** Restore `apps/teams/.env` from your backup, remove `SPCS_VPC_SERVICE_ID` from `apps/teams/.env` and delete `packages/teams-edge/wrangler.local.jsonc`, and delete the temporary tunnel-token and key files (`rm -rf` for a temporary key directory).

   **GCP variant (run end to end on 2026-10-11/12).** Same groups, with these differences:

   - **Revoke before you delete the forwarding rule.** Run `SELECT SYSTEM$REVOKE_PRIVATELINK('<gcp project id>', '<gcloud access token>');` while the PSC forwarding rule still exists. This mirrors the Azure failure after endpoint deletion. The revoke succeeded ("Private link access revoked."), but the reverse order was not tried, so keep revoke first. The authorization is per project, so revoking it affects every endpoint from that project.
   - **Delete in this order**, checking each with a `gcloud ... list`: the Worker and Workers VPC service; the VM (this stops `cloudflared`) and its service account; the Cloud DNS records, then the zones; the forwarding rule, the reserved address and the subnet; the Cloud NAT, router and any IAP firewall rule; the VPC. Then delete the tunnel (`1022` while `cloudflared` is connected), and any Secret Manager secret that is left. The delete of the VM, DNS and NAT can exceed a two-minute shell timeout; run it in the background and check each `list`.
   - **Entra and bot.** As for Azure: delete the throwaway Azure Bot (and its resource group if it has one) and its Entra app by display name, after checking the app ID is not the live bot's.
   - **Snowflake.** As above, plus the throwaway user, its policy and the egress rule from [PL11](#pl11-account-network-policy-blocks-the-containers-egress-account-host-mode), and the `GCPPSCID` rule (dropped with `AGENTS_TEAMS_NETWORK`).
   - **Local.** As for Azure, plus any `tunnel_token` file and startup script you wrote.
