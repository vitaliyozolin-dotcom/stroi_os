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

  const user = (state?.settings?.users ?? []).find((item) => normalizeEmail(item.email) === authenticated.email);
  if (!user || user.status === 'disabled' || !ALLOWED_ROLES.has(user.role)) return null;
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

export const stateForRole = (state, identity) => {
  const role = identity.role;
  if (role === 'management') return state;
  const safe = JSON.parse(JSON.stringify(state));

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
    return safe;
  }

  safe.project.targetCost = 0;
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

export const mergeStateForRole = (previous, incoming, identity) => {
  const role = identity.role;
  if (!previous || role === 'management') return incoming;
  if (role === 'foreman') {
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
      documents: incoming.documents,
      decisions: incoming.decisions,
      activity: incoming.activity,
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
