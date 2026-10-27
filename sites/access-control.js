const ALLOWED_ROLES = new Set(['management', 'foreman', 'client']);

const clean = (value, max = 240) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export const normalizeEmail = (value) => clean(value, 240).toLocaleLowerCase('en-US');

export const authenticatedIdentity = (request, env) => {
  const url = new URL(request.url);
  const ownerEmail = normalizeEmail(env.OWNER_EMAIL);
  const forwardedEmail = normalizeEmail(request.headers.get('oai-authenticated-user-email'));
  const email = forwardedEmail || (url.hostname === 'terminal.local' ? ownerEmail : '');
  if (!email) return null;

  let name = '';
  const encodedName = clean(request.headers.get('oai-authenticated-user-full-name'), 300);
  if (encodedName && request.headers.get('oai-authenticated-user-full-name-encoding') === 'percent-encoded-utf-8') {
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      name = '';
    }
  }
  const isOwner = Boolean(ownerEmail && email === ownerEmail);

  return {
    email,
    name: clean(name, 120) || (isOwner ? clean(env.OWNER_NAME, 120) : '') || email,
    isOwner,
  };
};

export const projectIdentity = (request, env, state) => {
  const authenticated = authenticatedIdentity(request, env);
  if (!authenticated) return null;
  if (authenticated.isOwner) return { ...authenticated, id: 'owner', role: 'management', status: 'active' };

  if (request.headers.get('oai-authenticated-user-access-mode') === 'local-membership') {
    const allowedProjects = clean(request.headers.get('oai-authenticated-user-projects'), 8000)
      .split(',')
      .filter(Boolean)
      .map((item) => {
        try { return decodeURIComponent(item); } catch { return ''; }
      });
    if (!allowedProjects.includes(clean(state?.project?.id, 100))) return null;
  }

  const user = (state?.settings?.users ?? []).find((item) => normalizeEmail(item.email) === authenticated.email);
  if (!user || user.status !== 'active' || !ALLOWED_ROLES.has(user.role)) return null;
  return {
    ...authenticated,
    id: clean(user.id, 100),
    name: clean(user.name, 120) || authenticated.name,
    role: user.role,
    status: user.status,
  };
};

const publicUser = (user) => ({
  id: clean(user.id, 100),
  name: clean(user.name, 120),
  email: '',
  role: ALLOWED_ROLES.has(user.role) ? user.role : 'foreman',
  status: user.status === 'disabled' ? 'disabled' : user.status === 'active' ? 'active' : 'invited',
});

/** Financial evidence uses the same boundary for metadata, aliases and downloads. */
export const documentVisibilityForRole = (state, identity) => {
  if (identity.role === 'management') return () => true;
  const entries = new Map((state.financeEntries ?? []).map(entry => [entry.id, entry]));
  const kindsByDocument = new Map();
  const remember = (id, kind) => {
    if (!id) return;
    const kinds = kindsByDocument.get(id) ?? new Set();
    kinds.add(kind); kindsByDocument.set(id, kinds);
  };
  for (const entry of entries.values()) {
    for (const id of [entry.acceptanceDocumentId, entry.paymentDocumentId, entry.historicalPayment?.sourceDocumentId,
      ...(entry.payments ?? []).map(payment => payment.documentId)]) remember(id, entry.kind);
  }
  for (const document of state.documents ?? []) {
    if (document.financeEntryId) remember(document.id, entries.get(document.financeEntryId)?.kind ?? 'unknown');
  }
  const restrictedIds = new Set(), restrictedKeys = new Set();
  for (const document of state.documents ?? []) {
    const kinds = kindsByDocument.get(document.id);
    // Clients keep explicitly published income evidence. Cost, account and
    // payment evidence stays private, including another record for the same file.
    if ((document.financeEntryId || kinds?.size) && (identity.role !== 'client'
      || document.clientVisible !== true || !kinds?.size || [...kinds].some(kind => kind !== 'income'))) {
      if (document.id) restrictedIds.add(document.id);
      if (document.fileKey) restrictedKeys.add(document.fileKey);
    }
  }
  return document => !restrictedIds.has(document.id)
    && (!document.fileKey || !restrictedKeys.has(document.fileKey))
    && (identity.role !== 'client' || document.clientVisible === true);
};

export const stateForRole = (state, identity) => {
  const role = identity.role;
  if (role === 'management') return state;
  const safe = JSON.parse(JSON.stringify(state));
  // Treasury contains private balances, account and contract evidence.
  delete safe.treasury;
  safe.documents = (safe.documents ?? []).filter(documentVisibilityForRole(state, identity));

  if (role === 'foreman') {
    safe.project.contractValue = 0;
    safe.project.targetCost = 0;
    safe.budgetMeta = { version: '', source: 'Скрыто для роли «Прораб»' };
    safe.budgetLines = [];
    safe.financeEntries = [];
    safe.supplierQuotes = [];
    safe.leads = [];
    safe.counterparties = (safe.counterparties ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      status: item.status,
      specialty: item.specialty,
      contactName: item.contactName,
      phone: item.phone,
      internalOwner: item.internalOwner,
      serviceRegion: item.serviceRegion,
      notes: item.notes,
      tags: item.tags,
    }));
    safe.tasks = (safe.tasks ?? []).filter((task) => clean(task.assigneeId, 100) === identity.id);
    safe.settings.users = (safe.settings?.users ?? []).filter((user) => user.role !== 'client').map(publicUser);
    // Historical activity has no audience marker and may contain payment sums.
    // Authoritative work status remains available through stages and own tasks.
    safe.activity = [];
    return safe;
  }

  safe.project.targetCost = 0;
  delete safe.project.siteProgressHistory;
  safe.budgetMeta = { version: '', source: 'Клиентский контур' };
  safe.budgetLines = [];
  safe.financeEntries = (safe.financeEntries ?? []).filter((item) => item.kind === 'income').map((item) => ({
    ...item,
    counterparty: '',
    counterpartyId: undefined,
    budgetLineId: undefined,
  }));
  safe.procurement = [];
  safe.counterparties = [];
  safe.supplierQuotes = [];
  safe.leads = [];
  safe.tasks = [];
  safe.fieldReports = (safe.fieldReports ?? []).filter((item) => item.clientVisible);
  safe.settings.users = [];
  safe.checkpoints = (safe.checkpoints ?? []).filter((item) => item.clientVisible);
  safe.documents = (safe.documents ?? []).filter((item) => item.clientVisible);
  safe.activity = [];
  return safe;
};

export const mergeStateForRole = (previous, incoming, identity, { serverManagedRoster = false } = {}) => {
  const role = identity.role;
  // Additive pilot data survives saves by an older client that has never seen it.
  if (previous?.treasury && !Object.hasOwn(incoming, 'treasury')) incoming = { ...incoming, treasury: previous.treasury };
  if (!previous || (role === 'management' && identity.isOwner && !serverManagedRoster)) return incoming;
  if (role === 'management') {
    return {
      ...incoming,
      settings: {
        ...incoming.settings,
        // Состав команды, email, роли и статусы — security boundary. Обычная
        // роль «Управление» может менять настройки, но roster меняет лишь owner.
        users: previous.settings?.users ?? [],
      },
    };
  }
  if (role === 'foreman') {
    const visibleDocument = documentVisibilityForRole({ ...previous, documents: [...(previous.documents ?? []), ...(incoming.documents ?? [])] }, identity);
    const hiddenDocuments = (previous.documents ?? []).filter(document => !visibleDocument(document));
    const previousActivityIds = new Set((previous.activity ?? []).map(event => event.id));
    const submittedTasks = new Map((incoming.tasks ?? []).map((task) => [clean(task.id, 100), task]));
    const tasks = (previous.tasks ?? []).map((task) => {
      if (clean(task.assigneeId, 100) !== identity.id) return task;
      const submitted = submittedTasks.get(clean(task.id, 100));
      if (!submitted || clean(submitted.assigneeId, 100) !== identity.id) return task;
      return {
        ...submitted,
        id: task.id,
        assigneeId: task.assigneeId,
        assigneeName: task.assigneeName,
        createdBy: task.createdBy,
        createdAt: task.createdAt,
      };
    });
    return {
      ...previous,
      project: {
        ...previous.project,
        forecastDate: incoming.project?.forecastDate ?? previous.project.forecastDate,
        cameraStatus: incoming.project?.cameraStatus ?? previous.project.cameraStatus,
      },
      stages: incoming.stages,
      procurement: incoming.procurement,
      tasks,
      fieldReports: incoming.fieldReports,
      checkpoints: incoming.checkpoints,
      // A restricted client never received the private records and cannot drop,
      // overwrite or reveal them by saving the visible documents collection.
      documents: [...(incoming.documents ?? []).filter(visibleDocument), ...hiddenDocuments],
      decisions: incoming.decisions,
      activity: [...(incoming.activity ?? []).filter(event => !previousActivityIds.has(event.id)), ...(previous.activity ?? [])].slice(0, 300),
    };
  }
  return {
    ...previous,
    decisions: incoming.decisions,
    activity: [...(incoming.activity ?? []), ...(previous.activity ?? [])]
      .filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index)
      .slice(0, 300),
  };
};
