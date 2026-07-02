# Cribl App Platform Developer Guide

## Versioning

`npm run package` increments your app version before creating the archive. By default, it increments the patch version, for example `1.0.0` to `1.0.1`.

Use these flags to choose a different version bump:

- `npm run package -- --minor` increments the minor version and resets patch to `0`.
- `npm run package -- --major` increments the major version and resets minor and patch to `0`.
- `npm run package -- --version X.Y.Z` sets the exact version.


## Global Variables

The following are set on `window` automatically when your app runs inside Cribl. They are read-only and always present — do **NOT** define, assign, or polyfill them in your app code, Vite config, or environment files.

| Variable | Example | Description |
|---|---|---|
| `CRIBL_API_URL` | `https://localhost:9000/api/v1` | Base URL for all Cribl API calls |
| `CRIBL_BASE_PATH` | `/app-ui/my-app` | The base path your app is mounted at |

## How to Get User Info

Your app can read basic identity and profile info for the currently signed-in Cribl user via `window.getCriblUser()`. It returns a Promise that resolves to:

| Field | Type | Always present? |
|---|---|---|
| `id` | `string` | yes |
| `username` | `string` | yes |
| `email` | `string` | no |
| `firstName` | `string` | no |
| `lastName` | `string` | no |
| `initials` | `string` | no |

Example:

```js
const user = await window.getCriblUser();
console.log(`Hello, ${user.firstName ?? user.username}!`);
```

The result is memoized — subsequent calls return the same resolved Promise. `getCriblUser` is read-only; do not redefine it.

## How API Calls Work (Fetch Proxy)

Your app runs inside a sandboxed iframe. The platform **automatically intercepts all `fetch()` calls** to `CRIBL_API_URL` and proxies them through the parent window. This is transparent to your code — just use `fetch()` normally.

**What the proxy does for you:**
- Injects authentication headers (your app never sees or handles auth tokens)
- Rewrites URLs to scope requests to your app
- Streams responses back to your app

**What this means for your code:**
- Use `fetch()` as normal — it just works
- You do NOT need to handle authentication
- You cannot override or replace `window.fetch` (it is locked)
- Requests that don't target `CRIBL_API_URL` are passed through directly (no proxy)

### URL Rewriting Rules

The proxy applies these rewrites automatically:

| What you call | What actually happens | Why |
|---|---|---|
| `fetch(CRIBL_API_URL + '/kvstore/my-key')` | Rewritten to `/api/v1/a/{yourAppId}/kvstore/my-key` | Scopes KV store access to your app |
| `fetch(CRIBL_API_URL + '/proxy/some/path')` | Rewritten to `/api/v1/a/{yourAppId}/proxy/some/path` | Scopes proxy calls to your app |
| `fetch('https://api.example.com/data')` | Rewritten to `/api/v1/a/{yourAppId}/proxy/api.example.com/data` | External calls are routed through the platform proxy |
| `fetch(CRIBL_API_URL + '/search/jobs')` | Passed through as-is | Standard API calls are not rewritten |

**Important:** Your app cannot access other apps' resources. Any request targeting a different app ID will be rejected.

### Request Timeout

Proxied requests time out after **30 seconds** if no response is received. Use `AbortController` if you need to cancel requests earlier.

## Platform APIs

API endpoint definitions are available in `openapi.json` (if downloaded during project setup).

### Key-Value Store

Each app has a scoped KV store. Use `CRIBL_API_URL` as the base — the proxy handles scoping.

| Operation | Method | URL | Body |
|---|---|---|---|
| Get | GET | `CRIBL_API_URL + '/kvstore/the/path/to/key'` | — |
| Set | PUT | `CRIBL_API_URL + '/kvstore/the/path/to/key'` | value |
| Delete | DELETE | `CRIBL_API_URL + '/kvstore/the/path/to/key'` | — |
| List keys | POST | `CRIBL_API_URL + '/kvstore/keys'` | `{ prefix: 'my/key/prefix' }` |

### Config Group Context

Cribl REST API endpoints that don't begin with `/system/` are contextual and can be called in the context of a config group using the prefix `/m/:groupId`. Config groups can be listed using the `/master/groups` endpoint.

Endpoints beginning with `/search/` should ALWAYS use `groupId` set to `default_search` — for example: `/m/default_search/search/jobs`. Never use any other group ID for search endpoints.

When asked to build a feature, always inspect Cribl REST APIs and understand the context of the request before starting to build.

### External API Calls

To call external APIs, just use `fetch()` with the full URL. The platform will automatically route these through your app's proxy endpoint. The external domain must be declared in your app's `config/proxies.yml`.

### proxies.yml — External Domain Configuration

Your app must declare every external domain it needs to access in `config/proxies.yml`. This file lives in your project's `config/` directory and gets packaged with your app. Admins can see exactly which external endpoints your app communicates with at install time.

**Schema:**

```yaml
# config/proxies.yml
# Top-level keys are domain:port pairs (port optional, defaults to 443)

api.openai.com:
  timeout: 10000          # Optional: request timeout in ms (1000–120000, default 30000)

  # Optional: verify the upstream TLS certificate chain. Defaults to `true`.
  # Set to `false` only when targeting trusted internal endpoints that present
  # self-signed or otherwise untrusted certificates.
  rejectUnauthorized: true

  paths:                   # Optional: control which URL paths are allowed
    allowlist:             # Prefix match — request path must start with one of these
      - /v1/chat/
      - /v1/models
    blocklist:             # Prefix match — these paths are always blocked (takes precedence over allowlist)
      - /v1/admin/

  headers:                 # Optional: control header forwarding and injection
    inject:                # Headers to add to every outgoing request to this domain
      x-api-key: "'static-key'"
      Authorization: "'Bearer ' + kv.openaiApiKey"
      x-custom: kv.myHeaderValue
    allowlist:             # Only forward these headers from the original request (supports wildcards)
      - content-type
      - accept
      - x-custom-*
    blocklist:             # Never forward these headers (takes precedence, supports wildcards)
      - x-internal-*
```

**Header injection expressions** support:
- String literals: `"'my-static-value'"`
- KV store lookups: `kv.mySecretKey` (resolves encrypted KV values at request time)
- Concatenation: `"'Bearer ' + kv.apiToken"`

**Security notes:**
- Sensitive headers (`cookie`, `authorization`, `proxy-authorization`, `host`, `connection`, `transfer-encoding`) are always stripped from the original request before forwarding — use `headers.inject` to set auth headers instead
- The platform validates target domains against SSRF protections (private/reserved IPs are blocked)
- Requests are rate-limited per app (100 requests/minute)
- All proxied requests use HTTPS
- Upstream TLS certificates are verified by default (`rejectUnauthorized: true`). Disable only for trusted internal endpoints with self-signed certs.

**Example — minimal config for a single API:**

```yaml
# config/proxies.yml
api.example.com:
  headers:
    inject:
      Authorization: "'Bearer ' + kv.apiKey"
```

**Example — multiple domains with path restrictions:**

```yaml
# config/proxies.yml
api.openai.com:
  timeout: 60000
  paths:
    allowlist:
      - /v1/chat/completions
      - /v1/embeddings
  headers:
    inject:
      Authorization: "'Bearer ' + kv.openaiKey"

hooks.slack.com:
  paths:
    allowlist:
      - /services/
  headers:
    inject:
      Content-Type: "'application/json'"
```

**How it connects to fetch:** When your app calls `fetch('https://api.openai.com/v1/chat/completions', ...)`, the platform rewrites this to `/api/v1/a/{yourAppId}/proxy/api.openai.com/v1/chat/completions`, looks up `api.openai.com` in your `proxies.yml`, validates the path, injects headers, and forwards the request.

### policies.yml — Product API Access Configuration

Your app can declare which Cribl product API paths it needs to access in `config/policies.yml`. This file lives in your project's `config/` directory and gets packaged with your app. Admins can see exactly which platform resources your app requires at install time.

When an admin shares your app with a user, the declared policies are automatically granted to that user for the duration of any request made through your app. Users with existing role permissions can also access those paths through your app without needing an explicit grant.

**Schema:**

```yaml
# config/policies.yml
policies:
  - object: '/system/lookups'       # Cribl product API path
    actions: ['GET']                 # HTTP methods: GET, POST, PUT, PATCH, DELETE, or ['*'] for all
  - object: '/products/stream/groups'
    actions: ['GET']
```

**Rules:**
- Only declare paths your app genuinely needs — admins review these at install time
- App-scoped paths (`/a/${appId}/kvstore/*`, `/a/${appId}/proxy/*`) are granted automatically via the AppUser role when an admin shares your app — do not redeclare them here

**Worker (`/w/:wid`) vs group (`/m/:gid`) paths:** Some APIs are available at both `/w/:wid/...` and `/m/:gid/...`. Each prefix is a separate policy `object`.

- **App calls `/m/:gid/...`:** Declare those paths only.
- **App calls `/w/:wid/...`:** Declare those paths **and** the matching `/m/:gid/...` paths. Worker API requests are authorized against the group-equivalent path.

**Example:**

```yaml
# config/policies.yml
policies:
  - object: '/system/lookups'
    actions: ['GET']
  - object: '/products/stream/groups'
    actions: ['GET']
  - object: '/products/stream/groups/*'
    actions: ['GET'] # Required for matching child group paths
  - object: '/m/:gid/system/projects/*'
    actions: ['*'] # Wildcard: all methods for matching project paths
```

**Path matching:** Declaring `/products/stream/groups` covers that exact collection path only. If your app reads individual groups, include `/products/stream/groups/*` or `/products/stream/groups/:gid`; otherwise group results can be empty.

**How it works:** When your app calls `fetch('/api/v1/system/lookups')`, the platform rewrites this to `/api/v1/a/{yourAppId}/system/lookups`, checks that `GET /system/lookups` is declared in your `policies.yml`, and grants access if the requesting user was shared the app by an admin.

**Live preview:** editing `config/policies.yml`, `config/proxies.yml`, or `package.json` while running `npm run dev` reloads the app automatically so your changes take effect without a manual refresh.

## React Router

When using React Router, set the basename to `window.CRIBL_BASE_PATH`:

```jsx
<BrowserRouter basename={window.CRIBL_BASE_PATH}>
```

## Navigation

The platform synchronizes navigation between your app and the parent Cribl UI. If you use `history.pushState()` or `history.replaceState()`, the parent URL bar will update to reflect your app's current route. Navigation changes from the parent are also forwarded to your app as `popstate` events.

### Linking Out of Your App

Your app runs in a sandboxed iframe, so to leave the app, set `target="_top"` (current tab) or `target="_blank"` (new tab) explicitly.

**Recommended for internal navigation: use a client-side router** (React Router, Vue Router, TanStack Router, etc.) configured with `basename={window.CRIBL_BASE_PATH}`, and navigate with the router's `<Link>` (or equivalent). You get SPA-style transitions, automatic integration with the platform's URL sync, and no risk of the absolute-path pitfall in **Avoid** plain `<a>` tags.

| Intent | Markup |
|---|---|
| Stay inside your app (recommended) | `<Link to="/page">` from your router, with `basename={window.CRIBL_BASE_PATH}` |
| Leader UI, current tab | `<a href="/search/jobs/123" target="_top">` |
| Leader UI, new tab | `<a href="/search/jobs/123" target="_blank">` |
| External URL, current tab | `<a href="https://docs.cribl.io/..." target="_top">` |
| External URL, new tab | `<a href="https://docs.cribl.io/..." target="_blank">` |

**Live preview (`npm run dev`):** absolute paths resolve against your dev server, not the Leader UI, so `target="_top"` won't reach Cribl. Test those in installed mode.

