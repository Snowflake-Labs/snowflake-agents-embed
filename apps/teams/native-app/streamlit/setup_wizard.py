# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
import base64
import json
import re
import streamlit as st
import snowflake.snowpark.context as ctx
from pathlib import Path

GUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
CDN_HOST_RE = re.compile(r"^[A-Za-z0-9.-]+(?::\d+)?$")
CDN_ORIGIN_RE = re.compile(r"^https://[A-Za-z0-9.-]+(?::\d+)?$")


def _guid(value: str) -> bool:
    return bool(GUID_RE.match(value.removeprefix("api://") if value.startswith("api://") else value))


def _cdn_ok(value: str) -> bool:
    return bool(CDN_HOST_RE.match(value) or CDN_ORIGIN_RE.match(value))


# ── Network mode helpers (tab 8). Pure functions: no Streamlit or session calls. ──
NETWORK_MODES = ("public", "hybrid", "privatelink")
INGRESS_HOST_RE = re.compile(r"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$")
IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,254}$")
# Private-endpoint ID per cloud: network rule TYPE and the ID format it takes.
ENDPOINT_ID_RULES = {
    "aws": ("AWSVPCEID", re.compile(r"^vpce-[0-9a-f]{8,17}$")),
    "azure": ("AZURELINKID", re.compile(r"^[0-9]{1,20}$")),
    "gcp": ("GCPPSCID", re.compile(r"^[0-9]{1,20}$")),
}
# Keys of SYSTEM$GET_PRIVATELINK_CONFIG() the Network tab uses. The SPCS keys can be
# absent on Azure and GCP.
PRIVATELINK_KEYS = (
    "privatelink-account-url",
    "regionless-privatelink-account-url",
    "app-service-privatelink-url",
    "app-service-privatelink-url-next",
    "spcs-auth-privatelink-url",
    "spcs-registry-privatelink-url",
    "privatelink-ocsp-url",
    "privatelink-vpce-id",
    "privatelink-pls-id",
    "privatelink-gcp-service-attachment",
)
PRIVATELINK_CONFIG_SQL = "USE ROLE ACCOUNTADMIN;\nSELECT SYSTEM$GET_PRIVATELINK_CONFIG();"
# Hostnames from SYSTEM$GET_PRIVATELINK_CONFIG(); app-service-privatelink-url is a wildcard.
DNS_HOST_RE = re.compile(r"^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$")
COMPUTE_POOL = "AGENTS_TEAMS_APP_POOL"
OAUTH_INTEGRATION = "CORTEX_TEAMS_OAUTH"
DEFAULT_PAT_USER = "AGENTS_TEAMS_SVC"
RULE_SCHEMA = "AGENTS_TEAMS_NETWORK.RULES"


def parse_status(status):
    """Split CONFIG.GET_SERVER_STATUS output into status, endpoint and privatelink.

    The status part is SYSTEM$GET_SERVICE_STATUS JSON and can contain spaces, so split
    on the last " endpoint=". Hosts that are not bare hostnames (None, or a
    "provisioning in progress" sentence) come back as None.
    """
    out = {"status": None, "endpoint": None, "privatelink": None}
    if not isinstance(status, str):
        return out
    head, sep, tail = status.rpartition(" endpoint=")
    if not sep:
        return out
    out["status"] = head.removeprefix("status=")
    endpoint, _, private = tail.partition(" privatelink=")
    for key, value in (("endpoint", endpoint), ("privatelink", private)):
        host = value.strip().removeprefix("https://")
        if INGRESS_HOST_RE.match(host):
            out[key] = host
    return out


def parse_region(region):
    """Cloud ("aws", "azure" or "gcp") from CURRENT_REGION(), e.g. PUBLIC.AWS_US_WEST_2."""
    if not isinstance(region, str):
        return None
    cloud = region.strip().upper().rsplit(".", 1)[-1].split("_", 1)[0].lower()
    return cloud if cloud in ENDPOINT_ID_RULES else None


def parse_privatelink_config(text):
    """Known keys from SYSTEM$GET_PRIVATELINK_CONFIG() JSON. Raises ValueError."""
    try:
        data = json.loads(text)
    except (TypeError, ValueError) as e:
        raise ValueError(f"not valid JSON: {e}") from None
    if not isinstance(data, dict):
        raise ValueError("expected a JSON object")
    return {k: data[k].strip() for k in PRIVATELINK_KEYS if isinstance(data.get(k), str) and data[k].strip()}


def parse_endpoint_ids(text):
    """Split comma, space or newline separated endpoint IDs, dropping duplicates."""
    seen = []
    for part in re.split(r"[\s,]+", text or ""):
        if part and part not in seen:
            seen.append(part)
    return seen


def network_sql(cloud, mode, endpoint_ids, pat_user, rule_schema=RULE_SCHEMA):
    """ACCOUNTADMIN SQL for hybrid / privatelink. Raises ValueError on bad input.

    Every statement is idempotent (IF NOT EXISTS, then SET), so re-running it after a
    change, e.g. a new endpoint ID, is safe. The pool policy is new rather than the T8
    NAT /24 policy, so switching back to public only needs that policy reattached.
    """
    if mode not in ("hybrid", "privatelink"):
        raise ValueError("network SQL is only needed for hybrid or privatelink")
    if not IDENT_RE.match(pat_user or ""):
        raise ValueError("PAT user must be a plain identifier, e.g. " + DEFAULT_PAT_USER)
    db, _, schema = rule_schema.partition(".")
    if not (IDENT_RE.match(db) and IDENT_RE.match(schema)):
        raise ValueError("rule schema must be DATABASE.SCHEMA")
    pat_user = pat_user.upper()
    pool_rule = f"{rule_schema}.AGENTS_TEAMS_POOL_RULE"
    lines = [
        "USE ROLE ACCOUNTADMIN;",
        f"CREATE DATABASE IF NOT EXISTS {db};",
        f"CREATE SCHEMA IF NOT EXISTS {rule_schema};",
        "",
        f"-- Container -> Snowflake: allow user tokens the service forwards from {COMPUTE_POOL}.",
        "-- Without this every forwarded token fails with 390422.",
        f"CREATE NETWORK RULE IF NOT EXISTS {pool_rule}",
        f"  TYPE = COMPUTE_POOL MODE = INGRESS VALUE_LIST = ('{COMPUTE_POOL}');",
        f"ALTER NETWORK RULE {pool_rule} SET VALUE_LIST = ('{COMPUTE_POOL}');",
        "CREATE NETWORK POLICY IF NOT EXISTS AGENTS_TEAMS_POOL_POLICY",
        f"  ALLOWED_NETWORK_RULE_LIST = ({pool_rule});",
        f"ALTER NETWORK POLICY AGENTS_TEAMS_POOL_POLICY SET ALLOWED_NETWORK_RULE_LIST = ({pool_rule});",
        f"ALTER SECURITY INTEGRATION {OAUTH_INTEGRATION} SET NETWORK_POLICY = AGENTS_TEAMS_POOL_POLICY;",
    ]
    if mode == "privatelink":
        if cloud not in ENDPOINT_ID_RULES:
            raise ValueError("cloud must be aws, azure or gcp")
        rule_type, id_re = ENDPOINT_ID_RULES[cloud]
        if not endpoint_ids:
            raise ValueError("at least one private endpoint ID is required")
        bad = [i for i in endpoint_ids if not id_re.match(i)]
        if bad:
            raise ValueError(f"not a valid {rule_type} value: {', '.join(bad)}")
        values = ", ".join(f"'{i}'" for i in endpoint_ids)
        pl_rule = f"{rule_schema}.AGENTS_TEAMS_PL_INGRESS_RULE"
        lines += [
            "",
            "-- Edge -> SPCS ingress: the service PAT only works through your private endpoint.",
            "-- This replaces the Cloudflare IP policy (T7) on the PAT user.",
            f"CREATE NETWORK RULE IF NOT EXISTS {pl_rule}",
            f"  TYPE = {rule_type} MODE = INGRESS VALUE_LIST = ({values});",
            f"ALTER NETWORK RULE {pl_rule} SET VALUE_LIST = ({values});",
            "CREATE NETWORK POLICY IF NOT EXISTS AGENTS_TEAMS_PL_INGRESS_POLICY",
            f"  ALLOWED_NETWORK_RULE_LIST = ({pl_rule});",
            f"ALTER NETWORK POLICY AGENTS_TEAMS_PL_INGRESS_POLICY SET ALLOWED_NETWORK_RULE_LIST = ({pl_rule});",
            f"ALTER USER {pat_user} SET NETWORK_POLICY = AGENTS_TEAMS_PL_INGRESS_POLICY;",
            "",
            "-- Optional, Business Critical only: block every public login to the account.",
            "-- Sign in once over PrivateLink first. Enforcing without a working private",
            "-- login locks the account out until Snowflake Support recovers it.",
            "-- SELECT SYSTEM$ENFORCE_PRIVATELINK_ACCESS_ONLY();",
            "-- Revert: SELECT SYSTEM$DISABLE_PRIVATELINK_ACCESS_ONLY();",
        ]
    lines += [
        "",
        "-- Users with their own network policy override the integration's policy, so they",
        "-- get 390422 from the app. Add the pool rule to each listed policy. This view",
        "-- lags by up to about 2 hours.",
        "SELECT ref_entity_name AS user_name, policy_name",
        "  FROM SNOWFLAKE.ACCOUNT_USAGE.POLICY_REFERENCES",
        "  WHERE policy_kind = 'NETWORK_POLICY' AND ref_entity_domain = 'USER'",
        f"    AND ref_entity_name <> '{pat_user}';",
    ]
    return "\n".join(lines) + "\n"


def dns_rows(config, private_ingress):
    """(host, needed for) rows for the private DNS zone.

    Missing keys and values that are not hostnames are skipped, so pasted JSON never
    reaches the page as anything but a hostname.
    """
    rows = []
    if private_ingress:
        rows.append((private_ingress, "privatelink: the edge's SPCS_BASE (copy verbatim)"))
    for key, use in (
        ("app-service-privatelink-url", "privatelink: SPCS ingress (wildcard)"),
        ("app-service-privatelink-url-next", "privatelink: SPCS ingress, newer host form"),
        ("spcs-auth-privatelink-url", "privatelink: SPCS ingress authentication"),
        ("privatelink-account-url", "admin and user logins over PrivateLink"),
        ("regionless-privatelink-account-url", "admin and user logins over PrivateLink"),
        ("privatelink-ocsp-url", "certificate revocation (OCSP) checks"),
        ("spcs-registry-privatelink-url", "optional: image push over PrivateLink"),
    ):
        host = (config or {}).get(key, "").removeprefix("https://").rstrip("/")
        if DNS_HOST_RE.match(host):
            rows.append((host, use))
    return rows


DNS_RECORD = {
    "aws": "CNAME to the VPC endpoint DNS name, in a Route 53 private hosted zone",
    "azure": "A record to the private endpoint IP, in an Azure Private DNS zone",
    "gcp": "A record to the Private Service Connect endpoint IP, in a Cloud DNS private zone",
}
ENDPOINT_ID_HELP = {
    "aws": "VPC endpoint ID, e.g. `vpce-0123456789abcdef0` (VPC console → Endpoints).",
    "azure": (
        "Private endpoint link identifier (a number). As ACCOUNTADMIN run "
        "`SELECT SYSTEM$GET_PRIVATELINK_AUTHORIZED_ENDPOINTS();` and copy `linkIdentifier`."
    ),
    "gcp": (
        "PSC connection ID (a number): `gcloud compute forwarding-rules describe <rule> "
        "--region=<region> --format=\"value(pscConnectionId)\"`."
    ),
}

IMG_DIR = Path(__file__).parent / "img" / "entra-setup"
BRAND_DIR = Path(__file__).parent / "img"


def _set_secret(session, name: str, val: str) -> str:
    """Bind secret values so they never appear in QUERY_HISTORY statement text."""
    rows = session.sql("CALL CONFIG.SET_SECRET(?, ?)", params=[name, val]).collect()
    if not rows:
        return ""
    cell = rows[0][0]
    return cell if isinstance(cell, str) else str(cell)


def _b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode()


def _img(name: str):
    """Render a screenshot inside a collapsible expander.

    Native App Streamlit does not support st.image; use the same base64
    markdown path as the branded header.
    """
    path = IMG_DIR / name
    if path.exists():
        with st.expander("Show screenshot"):
            st.markdown(
                f'<img src="data:image/png;base64,{_b64(path)}" style="max-width:100%;">',
                unsafe_allow_html=True,
            )


st.set_page_config(page_title="Snowflake Agents for Teams (Unofficial) - Setup", layout="centered")

# ── Branded header ────────────────────────────────────────────────────────────
_sf  = BRAND_DIR / "snowflake-icon.png"
_t   = BRAND_DIR / "teams-icon.png"
_cog = BRAND_DIR / "setup-icon.png"

if _sf.exists() and _t.exists() and _cog.exists():
    sf_b64  = _b64(_sf)
    t_b64   = _b64(_t)
    cog_b64 = _b64(_cog)
    st.markdown(
        f"""
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:4px;">
          <img src="data:image/png;base64,{sf_b64}"  width="38" style="border-radius:6px;">
          <span style="font-size:22px;color:#aaa;font-weight:300;">+</span>
          <img src="data:image/png;base64,{t_b64}"   width="68" style="border-radius:6px;">
          <span style="font-size:22px;color:#aaa;font-weight:300;margin-left:4px;">|</span>
          <img src="data:image/png;base64,{cog_b64}" width="36" style="opacity:.75;margin-left:4px;">
          <div style="margin-left:6px;">
            <div style="font-size:22px;font-weight:700;line-height:1.1;">Snowflake Agents for Teams (Unofficial)</div>
            <div style="font-size:13px;color:#888;">Setup Wizard</div>
          </div>
        </div>
        <hr style="margin-top:8px;margin-bottom:16px;border:none;border-top:1px solid #e0e0e0;">
        """,
        unsafe_allow_html=True,
    )

st.caption(
    "Complete each tab in order to connect your Microsoft Entra ID app to Snowflake "
    "and start your SPCS service."
)
st.info(
    "If the Entra app and Azure Bot already exist, skip tabs 1–6 and paste the "
    "IDs and secrets from `.env` on tab 7."
)

# Make the tab bar horizontally scrollable when tabs overflow the viewport.
# Snowsight sandboxes styles inside an iframe; target the stTabs div directly.
st.markdown(
    """
    <style>
    div[data-testid="stTabs"] > div:first-child {
        overflow-x: auto;
        overflow-y: hidden;
        flex-wrap: nowrap !important;
        scrollbar-width: thin;
        -webkit-overflow-scrolling: touch;
    }
    div[data-testid="stTabs"] > div:first-child > button {
        white-space: nowrap;
        flex-shrink: 0;
    }
    </style>
    """,
    unsafe_allow_html=True,
)

tabs = st.tabs([
    "1 · Register",
    "2 · Expose API",
    "3 · Secret",
    "4 · Permissions",
    "5 · Azure Bot",
    "6 · Bot Creds",
    "7 · Snowflake",
    "8 · Network",
    "9 · Finish",
])

# ── Tab 1: Register the Entra ID app ─────────────────────────────────────────
with tabs[0]:
    st.header("Register the Entra ID app")
    st.markdown(
        """
1. Go to **[portal.azure.com](https://portal.azure.com)** → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. Fill in the fields below and click **Register**.
"""
    )

    _img("01-register-app.png")

    with st.expander("ℹ️ Field guide - Register an application"):
        st.markdown(
            """
| Field | What to enter |
|---|---|
| **Name** | Any display name, e.g. `agents-teams-app` |
| **Supported account types** | *Single tenant* - only your org's users |
| **Redirect URI** | Leave blank for now - not needed for the SSO flow |

> **Why single tenant?**  The OBO (On-Behalf-Of) flow exchanges your users' Teams SSO tokens for Snowflake-audience tokens.
> That only works within one tenant, so single-tenant is the correct choice.
"""
        )

# ── Tab 2: Expose an API scope ────────────────────────────────────────────────
with tabs[1]:
    st.header("Expose an API scope")
    st.markdown(
        """
1. In your new app registration, go to **Manage → Expose an API**.
2. Click **Add a scope**. Azure will prompt you to set the **Application ID URI** first - replace the default with `api://<edge-host>/<client-id>`, where `<edge-host>` is the host that will serve the tab (`TAB_BASE_HOST`: your Cloudflare host or self-hosted edge).
3. Fill in the scope panel that opens on the right.
"""
    )

    _img("02-expose-api-scope.png")

    with st.expander("ℹ️ Field guide - Add a scope"):
        st.markdown(
            """
| Field | What to enter |
|---|---|
| **Scope name** | `access_as_user` |
| **Who can consent** | *Admins and users* |
| **Admin consent display name** | `Access Snowflake Agents for Teams (Unofficial) integration` |
| **Admin consent description** | `Allows the app to call the Snowflake Cortex Agent on behalf of the signed-in user.` |
| **User consent display name** | `Access Snowflake Agents for Teams (Unofficial) integration` |
| **State** | *Enabled* |

> **Application ID URI** — must be `api://<edge-host>/<your-client-id>`, using the same host as the CDN domain in tab 9.
> Teams SSO rejects any other host with `AADSTS500011`. This is the Teams SSO / OBO app, not the Snowflake OAuth resource app that
> tab 7 asks for. You can also set it with `az ad app update --id <client-id> --identifier-uris api://<edge-host>/<client-id>`.
"""
        )

# ── Tab 3: Create a client secret ────────────────────────────────────────────
with tabs[2]:
    st.header("Create a client secret")
    st.markdown(
        """
1. Go to **Manage → Certificates & secrets → Client secrets → New client secret**.
2. Give it a description (e.g. `agents-teams-app`) and choose an expiry.
3. **Copy the secret Value immediately** - it is only shown once.
"""
    )

    _img("03-client-secret.png")

    with st.expander("ℹ️ What you need from this page"):
        st.markdown(
            """
| Value | Where to paste it |
|---|---|
| **Application (client) ID** *(from Overview)* | **OBO Client App ID** in tab 7 |
| **Client secret Value** *(from Certificates & secrets)* | **OBO Client Secret** in tab 7 |

> ⚠️ **The secret Value column is only visible immediately after creation.** If you navigate away, you must create a new secret.
"""
        )

# ── Tab 4: Add API permissions ────────────────────────────────────────────────
with tabs[3]:
    st.header("Add API permissions")
    st.markdown(
        """
1. Go to **Manage → API permissions → Add a permission → Microsoft Graph → Delegated permissions**.
2. Add **User.Read** (it may already be there by default).
3. Optionally click **Grant admin consent** to pre-approve for all users.
"""
    )

    _img("04-api-permissions.png")

    with st.expander("ℹ️ Why User.Read?"):
        st.markdown(
            """
The Teams JS SDK calls `getAuthToken()` to get a token on behalf of the signed-in user.
The `User.Read` scope is the minimum required for that SSO token to carry a valid identity claim
that Snowflake's External OAuth integration can validate.

No other Graph permissions are required for this integration.
"""
        )

# ── Tab 5: Create an Azure Bot ────────────────────────────────────────────────
with tabs[4]:
    st.header("Create an Azure Bot")
    st.markdown(
        """
The bot lets users query Snowflake Agents for Teams (Unofficial) directly from a Teams channel or chat.
You need an **Azure Bot resource** — this is separate from the Entra app you registered above.

1. Go to **[portal.azure.com](https://portal.azure.com)** → **Create a resource** → search **"Azure Bot"** → **Create**.
2. Fill in the required fields (bot handle, subscription, resource group).
3. For **Microsoft App ID**, choose **Create new Microsoft App ID** (or reuse the app from tabs 1-4).
4. Click **Review + create**, then **Create**.
"""
    )

    _img("05a-create-azure-bot.png")
    _img("05b-bot-deployment-complete.png")

    with st.expander("ℹ️ Field guide - Create Azure Bot"):
        st.markdown(
            """
| Field | What to enter |
|---|---|
| **Bot handle** | A unique name for the bot, e.g. `agents-teams-app` |
| **Subscription / Resource group** | Use your existing subscription and resource group |
| **Type of App** | *Single Tenant* |
| **Microsoft App ID** | Leave blank - Azure auto-generates one. Or paste an existing App ID to reuse the app from tabs 1-4. |
| **Pricing tier** | Standard (free for most usage) |

> **Tip:** Azure creates a new Entra app registration automatically when you leave the App ID blank.
> You can reuse the same app you registered in tabs 1-4 by pasting its Application (client) ID instead.
"""
        )

# ── Tab 6: Get the Bot App ID and Secret ─────────────────────────────────────
with tabs[5]:
    st.header("Get the Bot App ID and Secret")
    st.markdown(
        """
After the Azure Bot resource is created:

1. Click **Go to resource** → **Settings → Configuration**.
2. Copy the **Microsoft App ID** - this is your **Azure Bot App ID**.
3. Click **Manage Password** next to the App ID to open its Entra app registration.
4. Go to **Certificates & secrets → Client secrets → New client secret**.
5. Give it a description (e.g. `agents-teams-app`) and choose an expiry.
6. **Copy the secret Value immediately** - it is only shown once. This is your **Azure Bot App Secret**.
"""
    )

    _img("06a-bot-configuration.png")
    _img("06b-bot-client-secret.png")

    with st.expander("ℹ️ Where to find each value"):
        st.markdown(
            """
| Value | Location in Azure Portal |
|---|---|
| **Azure Bot App ID** | Bot resource → Settings → Configuration → *Microsoft App ID* field |
| **Azure Bot App Secret** | Bot's Entra app → Certificates & secrets → Client secrets → *Value* column |

> ⚠️ **The secret Value is only visible immediately after creation.** If you navigate away, delete it and create a new one.

> **Can I use the same app as tabs 1-4?**
> Yes - if you reused the same Entra app registration for the bot, the App ID and secret are the same as your OBO Client App ID and Secret.
> Using separate registrations gives cleaner permission scoping for production.
"""
        )

# ── Tab 7: Configure Snowflake ────────────────────────────────────────────────
with tabs[6]:
    st.header("Configure Snowflake")
    st.caption("Paste values from tabs 1–6, or from `.env` if you skipped those tabs.")
    with st.expander("Before you click Configure"):
        st.markdown(
            """
ACCOUNTADMIN must create `CORTEX_TEAMS_OAUTH` and `GRANT MODIFY` first — this
button only ALTERs it. `SNOWFLAKE_SCOPE` is `api://<resource-app-id>/session:role-any`
from **Snowflake App (OAuth Resource) Client ID**, not the OBO/bot app.
"""
        )

    col1, col2 = st.columns(2)
    with col1:
        tenant_id = st.text_input(
            "Microsoft Tenant ID",
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
            help="Found in Entra ID → Overview → Tenant ID.",
        )
        bot_app_id = st.text_input(
            "Azure Bot App ID",
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
            help="The Microsoft App ID from the Azure Bot resource (Settings → Configuration).",
        )
        bot_app_secret = st.text_input(
            "Azure Bot App Secret",
            type="password",
            help="The client secret Value from the bot's Entra app registration (Certificates & secrets).",
        )

    with col2:
        sf_app_id = st.text_input(
            "Snowflake App (OAuth Resource) Client ID",
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
            help=(
                "The Application ID URI of the app registration you exposed in tab 2. "
                "Enter just the UUID (the part after api://), or the full URI - both are accepted. "
                "This tells Snowflake which audience claim to expect on incoming tokens."
            ),
        )
        obo_client_id = st.text_input(
            "OBO Client App ID",
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
            help=(
                "The Application (client) ID from the Entra app you registered in tabs 1-4. "
                "The server uses this to exchange Teams SSO tokens for Snowflake-audience tokens."
            ),
        )
        obo_client_secret = st.text_input(
            "OBO Client Secret",
            type="password",
            help=(
                "The client secret Value you copied in tab 3. "
                "Stored as a Snowflake secret and used server-side only - never sent to the browser."
            ),
        )

    st.divider()
    st.subheader("Server environment")
    apps_api_host = st.text_input(
        "Snowflake Apps API host",
        placeholder="apps-api.c1.eu-west-2.aws.app.snowflake.com",
        help=(
            "Region-specific apps-api hostname for your account's cloud/region. "
            "Not returned by any SQL function — run SELECT CURRENT_REGION() (e.g. "
            "AWS_EU_WEST_2), lowercase the part before the first '_' as <cloud> and "
            "the rest with '_' -> '-' as <region>, then fill "
            "apps-api.c1.<region>.<cloud>.app.snowflake.com. 'c1' is right for most "
            "accounts; if this doesn't work, confirm the real host in Snowsight's "
            "DevTools Network tab on any Native Apps/Marketplace page."
        ),
    )

    st.divider()
    st.subheader("Agent & app")
    agent_fqn = st.text_input(
        "Default Cortex Agent FQN",
        placeholder="MY_DB.MY_SCHEMA.MY_AGENT",
        help=(
            "Fully-qualified name (database.schema.name) of the default persisted Cortex agent. "
            "Preselects that agent when the tab loads. Does not hide other agents — "
            "users still see every agent SHOW AGENTS returns unless you set an allow list."
        ),
    )
    agent_allow_list = st.text_area(
        "Agent Allow List (JSON)",
        placeholder='[{"fqn":"MY_DB.MY_SCHEMA.MY_AGENT","displayName":"My Agent"}]',
        help=(
            "Optional JSON array of agents users may pick from. "
            "Each entry: {\"fqn\": \"DB.SCHEMA.NAME\", \"displayName\": \"Label\"}. "
            "Leave empty for dynamic SHOW AGENTS (RBAC-filtered). "
            "A non-empty list makes the picker static."
        ),
        height=100,
    )
    teams_app_id = st.text_input(
        "Teams App ID",
        value="",
        help="The `id` from your Teams manifest. Used to build deep links back into the app.",
    )

    all_required = all([
        tenant_id, sf_app_id, bot_app_id, bot_app_secret, apps_api_host,
        obo_client_id, obo_client_secret, agent_fqn, teams_app_id,
    ])
    # agent_allow_list is optional — only validate JSON if provided
    allow_list_valid = True
    if agent_allow_list:
        import json as _json
        try:
            _json.loads(agent_allow_list)
        except ValueError:
            allow_list_valid = False
            st.warning("Agent Allow List is not valid JSON.")
    guid_ok = all([
        GUID_RE.match(tenant_id or ""),
        _guid(sf_app_id or ""),
        GUID_RE.match(bot_app_id or ""),
        GUID_RE.match(obo_client_id or ""),
        GUID_RE.match(teams_app_id or ""),
    ])
    if all_required and not guid_ok:
        st.warning("Tenant ID, app IDs, and Teams App ID must be GUIDs (api:// prefix allowed on the Snowflake App ID).")
    all_ready = all_required and allow_list_valid and guid_ok

    if st.button("Configure Security Integration", disabled=not all_ready, type="primary"):
        session = ctx.get_active_session()
        audience = sf_app_id if sf_app_id.startswith("api://") else f"api://{sf_app_id}"
        uuid_part = sf_app_id.removeprefix("api://")
        result = session.call("CONFIG.CONFIGURE_OAUTH", tenant_id, audience, uuid_part)
        if isinstance(result, str) and result.startswith("refuse:"):
            st.error(result)
        else:
            failed = False
            for name, val in [
                ("BOT_APP_ID", bot_app_id),
                ("BOT_APP_SECRET", bot_app_secret),
                ("OBO_CLIENT_ID", obo_client_id),
                ("OBO_CLIENT_SECRET", obo_client_secret),
                ("DEFAULT_AGENT_FQN", agent_fqn),
                ("TEAMS_APP_ID", teams_app_id),
                ("AGENT_ALLOW_LIST", agent_allow_list or ""),
                ("AZURE_TENANT_ID", tenant_id),
                ("SNOWFLAKE_SCOPE", f"{audience}/session:role-any"),
                ("APPS_API_HOST", apps_api_host),
            ]:
                set_result = _set_secret(session, name, val)
                if isinstance(set_result, str) and set_result.startswith("refuse:"):
                    st.error(set_result)
                    failed = True
                    break
            if not failed:
                st.success("✅ Security integration and secrets configured.")

    if st.button("Save default agent", disabled=not bool((agent_fqn or "").strip())):
        session = ctx.get_active_session()
        set_result = _set_secret(session, "DEFAULT_AGENT_FQN", agent_fqn.strip())
        if isinstance(set_result, str) and set_result.startswith("refuse:"):
            st.error(set_result)
        else:
            st.success(
                "Saved DEFAULT_AGENT_FQN. Roll the SPCS service on tab 9 so the "
                "container remounts the secret — the tab reads it from GET /api/config."
            )

# ── Tab 8: Network mode ──────────────────────────────────────────────────────
with tabs[7]:
    st.header("Network")
    st.markdown(
        "Choose how the app reaches Snowflake. **public** is the default and needs "
        "nothing on this tab. **hybrid** and **privatelink** are for accounts that "
        "restrict Snowflake to private connectivity (AWS PrivateLink, Azure Private "
        "Link or Google Cloud Private Service Connect)."
    )
    with st.expander("ℹ️ What each mode changes"):
        st.markdown(
            """
| Mode | Edge → SPCS ingress | Container → Snowflake | ACCOUNTADMIN SQL |
|---|---|---|---|
| **public** | Public ingress | Public account host | None on this tab |
| **hybrid** | Public ingress, edge unchanged | Internal SPCS host plus a compute pool network rule | Compute pool rule on `CORTEX_TEAMS_OAUTH` |
| **privatelink** | `privatelink_ingress_url`, through a private edge in your network | Same as hybrid | Also limits the service PAT user to your private endpoint |

The mode is applied by the next **Create Service** or **Roll service** on tab 9. Rolls
keep the saved mode, so a roll never silently switches back to public.
"""
        )

    if "network_mode" not in st.session_state:
        try:
            st.session_state.network_mode = ctx.get_active_session().call("CONFIG.GET_NETWORK_MODE")
            st.session_state.network_mode_error = None
        except Exception as e:
            st.session_state.network_mode = "public"
            st.session_state.network_mode_error = str(e)
    if st.session_state.get("network_mode_error"):
        st.warning(f"Could not read the saved network mode, showing public: {st.session_state.network_mode_error}")
    saved_mode = st.session_state.network_mode if st.session_state.network_mode in NETWORK_MODES else "public"

    mode = st.radio(
        "Network mode",
        NETWORK_MODES,
        index=NETWORK_MODES.index(saved_mode),
        horizontal=True,
        help="Saved in CONFIG.APP_SETTINGS. Picks the service spec Create Service and Roll service apply.",
    )
    if mode != "public":
        st.warning(
            "Apply the ACCOUNTADMIN SQL below **before** Create Service or Roll service "
            "with this mode. Until the compute pool rule is on `CORTEX_TEAMS_OAUTH`, every "
            "user call from the service fails with `390422`."
        )
    elif saved_mode != "public":
        st.warning(
            "Switching back to public: after the roll, put back the integration policy you "
            "had before (T8 in docs/teams/troubleshooting.md). The compute pool policy does not cover "
            "the public SPCS egress, so calls fail with `390422` while it is attached."
        )
    if st.button("Save network mode", disabled=mode == saved_mode):
        result = ctx.get_active_session().call("CONFIG.SET_NETWORK_MODE", mode)
        if isinstance(result, str) and result.startswith("refuse:"):
            st.error(result)
        else:
            st.session_state.network_mode = saved_mode = mode
            st.success(f"Saved: {result}. Run Create Service or Roll service on tab 9 to apply it.")

    if mode != "public":
        st.divider()

        # ── Detect ────────────────────────────────────────────────────────────
        st.subheader("8a · Detect")
        if "network_region" not in st.session_state:
            try:
                st.session_state.network_region = (
                    ctx.get_active_session().sql("SELECT CURRENT_REGION()").collect()[0][0]
                )
            except Exception:
                st.session_state.network_region = None
        region = st.session_state.network_region
        detected = parse_region(region)
        clouds = tuple(ENDPOINT_ID_RULES)
        cloud = st.selectbox(
            "Cloud",
            clouds,
            index=clouds.index(detected) if detected else 0,
            format_func={"aws": "AWS", "azure": "Azure", "gcp": "Google Cloud"}.get,
            help=f"Detected from CURRENT_REGION() = {region}" if region else "CURRENT_REGION() was not readable.",
        )

        if "privatelink_config" not in st.session_state:
            try:
                raw = ctx.get_active_session().sql("SELECT SYSTEM$GET_PRIVATELINK_CONFIG()").collect()[0][0]
                st.session_state.privatelink_config = parse_privatelink_config(raw)
            except Exception:
                st.session_state.privatelink_config = None
        pl_config = st.session_state.privatelink_config
        if pl_config is None:
            st.markdown(
                "The app cannot read the account's PrivateLink configuration (ACCOUNTADMIN "
                "only). Run this as ACCOUNTADMIN and paste the JSON result below:"
            )
            st.code(PRIVATELINK_CONFIG_SQL, language="sql")
            pasted = st.text_area("SYSTEM$GET_PRIVATELINK_CONFIG() result", height=120)
            if pasted.strip():
                try:
                    pl_config = parse_privatelink_config(pasted)
                except ValueError as e:
                    st.warning(f"Could not read that: {e}")
        else:
            st.success("Read the account's PrivateLink configuration.")

        endpoint_service = next(
            (pl_config[k] for k in ("privatelink-vpce-id", "privatelink-pls-id", "privatelink-gcp-service-attachment")
             if pl_config and k in pl_config),
            None,
        )
        if endpoint_service:
            st.markdown("Snowflake's side of the connection (create your private endpoint against it):")
            st.code(endpoint_service)

        if st.button("Read private ingress URL", help="From CONFIG.GET_SERVER_STATUS. Needs a running service."):
            try:
                st.session_state.server_status = parse_status(
                    ctx.get_active_session().call("CONFIG.GET_SERVER_STATUS")
                )
            except Exception as e:
                st.error(f"Could not read the service status: {e}")
        private_ingress = (st.session_state.get("server_status") or {}).get("privatelink")
        if private_ingress:
            st.code(f"https://{private_ingress}")
        elif mode == "privatelink":
            st.caption(
                "The private ingress URL appears once the service runs on an account with "
                "PrivateLink. Create the service on tab 9, then come back."
            )

        st.divider()

        # ── DNS ───────────────────────────────────────────────────────────────
        st.subheader("8b · Private DNS")
        st.markdown(
            f"Create one record per host: {DNS_RECORD[cloud]}. The edge host (the "
            "Cloudflare tunnel's `cloudflared` VM or the self-hosted edge) must resolve "
            "through that zone. Prefer the private ingress host over the wildcard: the "
            "wildcard can miss the certificate the ingress serves."
        )
        rows = dns_rows(pl_config, private_ingress)
        if rows:
            st.table([{"Host": host, "Needed for": use} for host, use in rows])
        else:
            st.caption("No hosts yet. Paste the PrivateLink configuration above.")

        st.divider()

        # ── SQL ───────────────────────────────────────────────────────────────
        st.subheader("8c · ACCOUNTADMIN SQL")
        endpoint_ids = []
        if mode == "privatelink":
            endpoint_ids = parse_endpoint_ids(
                st.text_area(
                    f"Private endpoint IDs ({ENDPOINT_ID_RULES[cloud][0]})",
                    height=80,
                    help="Separate several with commas or new lines.",
                )
            )
            st.caption(ENDPOINT_ID_HELP[cloud])
        pat_user = st.text_input(
            "Service PAT user",
            value=DEFAULT_PAT_USER,
            help="The Snowflake user whose PAT the edge sends to the SPCS ingress (`.env` SNOWFLAKE_USER).",
        )
        try:
            sql = network_sql(cloud, mode, endpoint_ids, (pat_user or "").strip())
        except ValueError as e:
            st.warning(str(e))
        else:
            st.markdown("Run as ACCOUNTADMIN in a worksheet. Every statement is safe to re-run.")
            st.code(sql, language="sql")

# ── Tab 9: Finish — CDN, Start Service, Endpoint URL ─────────────────────────
with tabs[8]:
    st.header("Finish")

    # ── CDN Domain ────────────────────────────────────────────────────────────
    st.subheader("9a · CDN Domain")
    st.markdown(
        "The Teams tab SPA and the edge are served from one host (`TAB_BASE_HOST`): "
        "your Cloudflare host or a self-hosted edge. Enter that public hostname or "
        "`https://` origin so CORS and `ALLOWED_ORIGINS` allow it. You can fill this "
        "before the first tab deploy, once the hostname is known."
    )
    cdn_domain = st.text_input(
        "CDN domain",
        placeholder="teams.example.com",
        help=(
            "Hostname (`<edge-host>`) or `https://<edge-host>` (no path). Same origin as "
            "`.env` `TAB_BASE_HOST`. Bound as CORS / ALLOWED_ORIGINS when you click "
            "Create Service."
        ),
    )
    cdn_valid = _cdn_ok(cdn_domain) if cdn_domain else False
    if cdn_domain and not cdn_valid:
        st.warning("CDN domain must be a hostname or https:// origin (no path).")
    elif cdn_valid:
        st.info(f"`{cdn_domain}` will be bound as `cdn_origin` when you click **Create Service** below.")

    st.divider()

    # ── Start SPCS Service ────────────────────────────────────────────────────
    st.subheader("9b · Start SPCS Service")
    st.markdown(
        "Creates the container service in Snowpark Container Services. "
        "Run this after configuring the security integration in tab 7, saving the "
        "network mode in tab 8 and updating the CDN domain above."
    )
    st.caption(f"Network mode: **{saved_mode}** (tab 8)")

    with st.expander("ℹ️ What this does"):
        st.markdown(
            """
- Calls `CONFIG.CREATE_SERVER_SERVICE` (APP_ADMIN), which applies the bundled spec via
  `SPECIFICATION_TEMPLATE_FILE`: `services/service_spec.yml` for public, or
  `services/service_spec_private.yml` for hybrid and privatelink.
- Binds the validated CDN origin as the spec's CORS allow-list.
- The service pulls the `agents-teams-app` image from your Snowflake image repository.
- Startup takes ~60 seconds.
"""
        )

    if st.button("Create Service", type="primary", disabled=not cdn_valid):
        session = ctx.get_active_session()
        try:
            result = session.call("CONFIG.CREATE_SERVER_SERVICE", cdn_domain)
            session.call("CONFIG.GRANT_ENDPOINT_ACCESS")
            st.success(
                f"{result}. Wait until GET_SERVER_STATUS is READY (~60s), then "
                "Show Endpoint URL. Approve `cortex_and_entra_egress` only if "
                "`SHOW PENDING SPECIFICATIONS IN APPLICATION AGENTS_TEAMS_APP` "
                "returns a row — use that `sequence_number`. Skip if already APPROVED."
            )
        except Exception as e:
            st.error(f"Failed to create service: {e}")

    st.markdown(
        "After changing secrets (default agent, allow list, OAuth) or the network mode, "
        "remount the container so it picks up the new values. Uses the CDN domain above."
    )
    if st.button("Roll service", disabled=not cdn_valid):
        session = ctx.get_active_session()
        try:
            result = session.call("CONFIG.ROLL_SERVER_SERVICE", cdn_domain)
            st.success(f"Service rolled: {result}")
            if isinstance(result, str) and "new ingress host" in result:
                st.warning(
                    "The service was recreated, so its ingress host is new. Copy it from "
                    "**Show Endpoint URL** below into the edge's `SPCS_BASE` and redeploy the tab."
                )
        except Exception as e:
            st.error(f"Failed to roll service: {e}")

    st.divider()

    # ── Endpoint URL ──────────────────────────────────────────────────────────
    st.subheader("9c · Endpoint URL")
    st.markdown("Retrieve the HTTPS ingress URLs for the running service.")

    if st.button("Show Endpoint URL"):
        session = ctx.get_active_session()
        parsed = parse_status(session.call("CONFIG.GET_SERVER_STATUS"))
        st.session_state.server_status = parsed
        endpoint = parsed["endpoint"]
        private = parsed["privatelink"]
        if endpoint or private:
            if endpoint:
                st.markdown("Public ingress:")
                st.code(f"https://{endpoint}")
            if private:
                st.markdown("Private ingress (`privatelink_ingress_url`):")
                st.code(f"https://{private}")
            if saved_mode == "privatelink":
                spcs_base = (
                    f"`https://{private}`" if private
                    else "the private ingress URL (not shown yet: check the account has PrivateLink)"
                )
                first = (
                    f"1. In privatelink mode the edge's `SPCS_BASE` is {spcs_base}, copied "
                    "verbatim. Only an edge inside your network (tab 8) can reach it.\n"
                )
            else:
                first = (
                    "1. The public ingress is the edge secret `SPCS_BASE` (not `VITE_SPCS_BASE`, "
                    "which must stay empty). Put `SPCS_BASE` in `apps/teams/.env`, then run "
                    "`bash apps/teams/scripts/set-edge-secrets.sh`.\n"
                )
            st.info(
                "**Next steps:**\n\n"
                + first
                + "2. Set the edge secret `SPCS_PAT` (ingress PAT for `SNOWFLAKE_USER`), then "
                "`bash apps/teams/scripts/deploy-tab.sh` so isolates pick up the secrets.\n"
                "3. Azure Bot messaging endpoint is the edge origin, **not** this ingress: "
                "`https://<TAB_BASE_HOST>/api/bot/messages`.\n"
                "4. Copy the public ingress host (no scheme) into `.env` `SPCS_INGRESS_HOST`, then "
                "sideload `packages/teams-manifest/agents-teams-app.zip` (`bash packages/teams-manifest/zip.sh`)."
            )
        else:
            st.warning("Service not ready yet - wait a moment and try again.")
