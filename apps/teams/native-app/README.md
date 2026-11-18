# Snowflake Agents for Teams (Unofficial)

Snowflake Agents for Teams (Unofficial) embeds Cortex agent chat in Microsoft Teams (tab + bot). This Native App runs the SPCS server that handles Bot Framework webhooks, Entra SSO token exchange, and Cortex streaming.

## After install

1. Grant the requested privileges (`CREATE COMPUTE POOL`, `CREATE EXTERNAL ACCESS INTEGRATION`, `CREATE SECURITY INTEGRATION`, `BIND SERVICE ENDPOINT`) and the `SNOWFLAKE.CORTEX_USER` database role.
2. Open the **setup wizard** Streamlit inside this application. It writes secrets via `CONFIG.SET_SECRET` and starts the server. Snowsight’s **Configure** form on each reference is not the write path — those bind a consumer-account secret, which the container does not read.
3. Have a role with `MANAGE APPLICATION SPECIFICATIONS` (ACCOUNTADMIN or SECURITYADMIN) approve the pending `cortex_and_entra_egress` specification, then recreate the service if you already started it:

   ```sql
   SHOW PENDING SPECIFICATIONS IN APPLICATION AGENTS_TEAMS_APP;
   ALTER APPLICATION AGENTS_TEAMS_APP APPROVE SPECIFICATION cortex_and_entra_egress SEQUENCE_NUMBER = <n>;
   ```

Full operator steps (Azure Bot / Entra apps, Cloudflare Worker edge, Teams sideload, verification): start at `docs/install-guide.md`, then `docs/teams/teams-install.md` (Path B: `docs/teams/teams-native-app.md`) in the snowflake-agents-embed repo.

The next Marketplace version/patch must include the redacted Entra setup screenshots in `streamlit/img/entra-setup/` (secret Value, Secret ID, and account are covered).
