const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const OIDC_AUDIENCE = 'company-os-export';
const COMPANY_OS_REPOSITORY = 'vitaliyozolin-dotcom/Company-OS';
const COMPANY_OS_REF = 'refs/heads/main';
const JWKS_TTL_MS = 15 * 60_000;

let oidcConfigCache = null;
let jwksCache = null;

const b64url = (value) => {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const decodeJsonPart = (value) => JSON.parse(new TextDecoder().decode(b64url(value)));

const audiences = (value) => Array.isArray(value) ? value : [value];

export const validateCompanyOsClaims = (claims, nowSeconds = Math.floor(Date.now() / 1000)) => {
  if (!claims || claims.iss !== OIDC_ISSUER) throw new Error('invalid_issuer');
  if (!audiences(claims.aud).includes(OIDC_AUDIENCE)) throw new Error('invalid_audience');
  if (claims.repository !== COMPANY_OS_REPOSITORY) throw new Error('invalid_repository');
  if (claims.ref !== COMPANY_OS_REF) throw new Error('invalid_ref');
  if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) < nowSeconds - 15) throw new Error('token_expired');
  if (Number.isFinite(Number(claims.nbf)) && Number(claims.nbf) > nowSeconds + 15) throw new Error('token_not_yet_valid');
  if (Number.isFinite(Number(claims.iat)) && Number(claims.iat) > nowSeconds + 60) throw new Error('invalid_issued_at');
  return true;
};

const readOidcConfig = async (fetchImpl = fetch) => {
  if (oidcConfigCache?.expiresAt > Date.now()) return oidcConfigCache.value;
  const response = await fetchImpl(`${OIDC_ISSUER}/.well-known/openid-configuration`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('oidc_config_unavailable');
  const value = await response.json();
  if (!String(value?.jwks_uri || '').startsWith(`${OIDC_ISSUER}/`)) throw new Error('invalid_jwks_uri');
  oidcConfigCache = { expiresAt: Date.now() + JWKS_TTL_MS, value };
  return value;
};

const readJwks = async (fetchImpl = fetch) => {
  if (jwksCache?.expiresAt > Date.now()) return jwksCache.value;
  const config = await readOidcConfig(fetchImpl);
  const response = await fetchImpl(config.jwks_uri, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('jwks_unavailable');
  const value = await response.json();
  if (!Array.isArray(value?.keys)) throw new Error('invalid_jwks');
  jwksCache = { expiresAt: Date.now() + JWKS_TTL_MS, value };
  return value;
};

export const verifyCompanyOsOidc = async (token, { fetchImpl = fetch, cryptoImpl = crypto } = {}) => {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('invalid_token');
  const header = decodeJsonPart(parts[0]);
  const claims = decodeJsonPart(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('invalid_algorithm');
  validateCompanyOsClaims(claims);

  const jwks = await readJwks(fetchImpl);
  const jwk = jwks.keys.find((item) => item.kid === header.kid && item.kty === 'RSA');
  if (!jwk) throw new Error('signing_key_not_found');
  const key = await cryptoImpl.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await cryptoImpl.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), signed);
  if (!valid) throw new Error('invalid_signature');
  return claims;
};

const cleanNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const cleanDate = (value) => typeof value === 'string' && value ? value : null;

const mapLeadStage = (stage) => ({
  new: 'new',
  qualified: 'lead',
  site_visit: 'lead',
  estimate: 'proposal',
  negotiation: 'negotiation',
  won: 'won',
  lost: 'lost',
})[String(stage || '').toLowerCase()] || String(stage || 'new').toLowerCase();

const parseStateRow = (row) => {
  try {
    const state = JSON.parse(row.state_json);
    if (!state?.project?.id || String(state.project.id).startsWith('__')) return null;
    return { row, state };
  } catch {
    return null;
  }
};

const financeProject = ({ row, state }) => {
  const commitments = (state.financeEntries ?? []).flatMap((entry) => {
    if (entry?.kind !== 'expense' || !['committed', 'accepted'].includes(entry.status)) return [];
    const remaining = Math.max(0, cleanNumber(entry.amount) - cleanNumber(entry.paidAmount));
    if (!remaining) return [];
    return [{
      id: String(entry.id),
      amount_rub: Math.round(remaining),
      due_date: cleanDate(entry.date),
      mandatory: true,
      status: entry.status === 'accepted' ? 'accepted' : 'open',
      source_ref: `ikioma:${state.project.id}:finance:${entry.id}`,
    }];
  });
  const inflows = (state.financeEntries ?? []).flatMap((entry) => {
    if (entry?.kind !== 'income' || entry.status === 'paid') return [];
    return [{
      id: String(entry.id),
      amount_rub: Math.round(Math.max(0, cleanNumber(entry.amount) - cleanNumber(entry.paidAmount))),
      due_date: cleanDate(entry.date),
      confirmed: false,
      status: 'expected',
      source_ref: `ikioma:${state.project.id}:finance:${entry.id}`,
    }];
  }).filter((item) => item.amount_rub > 0);
  return {
    project: `ИКИОМА · ${state.project.code || state.project.name || state.project.id}`,
    project_id: String(state.project.id),
    as_of: row.updated_at,
    cash_balance_rub: 0,
    bank_balance_confirmed: false,
    minimum_reserve_rub: 0,
    commitments,
    confirmed_inflows: inflows,
    source_ref: `ikioma:${state.project.id}:revision:${row.revision}`,
  };
};

const salesFromState = ({ row, state }) => (state.leads ?? []).map((lead) => ({
  project: 'ИКИОМА',
  opportunity_id: String(lead.id),
  stage: mapLeadStage(lead.stage),
  created_at: cleanDate(lead.createdAt),
  last_contact_at: cleanDate(lead.lastContactAt),
  next_action_at: cleanDate(lead.nextActionAt),
  value_rub: Math.round(cleanNumber(lead.budget)),
  margin_rub: 0,
  owner: String(lead.owner || ''),
  commercial_exception: false,
  source_ref: `ikioma:${state.project.id}:lead:${lead.id}:revision:${row.revision}`,
}));

const salesFromInbox = (rows) => rows.map((lead) => ({
  project: 'ИКИОМА',
  opportunity_id: String(lead.id),
  stage: String(lead.status || 'new'),
  created_at: cleanDate(lead.created_at),
  last_contact_at: null,
  next_action_at: null,
  value_rub: 0,
  margin_rub: 0,
  owner: '',
  commercial_exception: false,
  source_ref: `ikioma:lead-inbox:${lead.id}`,
}));

export const buildIkiomaCompanyOsPayload = ({ stateRows = [], leadRows = [], generatedAt = new Date().toISOString() } = {}) => {
  const parsed = stateRows.map(parseStateRow).filter(Boolean);
  const finance = parsed.map(financeProject);
  const stateSales = parsed.flatMap(salesFromState);
  const inboxSales = salesFromInbox(leadRows);
  const dedup = new Map();
  for (const item of [...inboxSales, ...stateSales]) dedup.set(item.opportunity_id, item);
  const latest = stateRows.map((row) => row.updated_at).filter(Boolean).sort().at(-1) || generatedAt;
  return {
    meta: {
      project: 'ikioma',
      generated_at: generatedAt,
      schema_version: 1,
      source_of_truth: 'IKIOMA OS PostgreSQL',
      privacy: 'no_customer_pii',
    },
    adapter_sources: [
      {
        project: 'ИКИОМА',
        source_id: 'ikioma-project-state',
        source_type: 'postgresql',
        source_of_truth_for: ['construction_finance', 'sales_pipeline'],
        schema: ['cash_balance_rub', 'as_of', 'amount_rub', 'due_date', 'opportunity_id', 'stage', 'created_at', 'last_contact_at', 'next_action_at', 'value_rub', 'margin_rub', 'owner'],
        required_canonical: ['commitment.amount_rub', 'commitment.due_date', 'sales.opportunity_id', 'sales.stage', 'sales.created_at', 'sales.next_action_at'],
        mapping: {
          'commitment.amount_rub': 'amount_rub',
          'commitment.due_date': 'due_date',
          'sales.opportunity_id': 'opportunity_id',
          'sales.stage': 'stage',
          'sales.created_at': 'created_at',
          'sales.next_action_at': 'next_action_at',
        },
        as_of: latest,
        max_age_minutes: 1440,
        read_only: true,
      },
    ],
    finance_projects: finance,
    sales_opportunities: [...dedup.values()],
    owner_exceptions: [],
  };
};

export const buildIkiomaCompanyOsExport = async (env) => {
  const [states, leads] = await Promise.all([
    env.DB.prepare(`
      SELECT project_id, state_json, revision, updated_at
      FROM project_state
      ORDER BY updated_at DESC
      LIMIT 100
    `).all(),
    env.DB.prepare(`
      SELECT id, project_id, created_at, status
      FROM lead_inbox
      ORDER BY created_at DESC
      LIMIT 500
    `).all(),
  ]);
  return buildIkiomaCompanyOsPayload({ stateRows: states?.results ?? [], leadRows: leads?.results ?? [] });
};

const bearer = (request) => {
  const value = String(request.headers.get('authorization') || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
};

export const handleCompanyOsExport = async (request, env) => {
  if (request.method !== 'GET') return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405 });
  if (!env.DB) return Response.json({ ok: false, error: 'storage_unavailable' }, { status: 503 });
  try {
    await verifyCompanyOsOidc(bearer(request));
  } catch {
    return Response.json({ ok: false, error: 'company_os_auth_required' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const payload = await buildIkiomaCompanyOsExport(env);
    return Response.json({ ok: true, ...payload }, {
      headers: {
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return Response.json({ ok: false, error: 'export_failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
};
