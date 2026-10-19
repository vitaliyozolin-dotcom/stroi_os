export type PageId =
  | 'overview'
  | 'project'
  | 'tasks'
  | 'marketing'
  | 'counterparties'
  | 'finance'
  | 'schedule'
  | 'procurement'
  | 'quality'
  | 'client'
  | 'settings';

export const pageLabels: Record<PageId, string> = {
  overview: 'Главная', project: 'Карточка проекта', tasks: 'Задачи',
  marketing: 'Маркетинг', counterparties: 'Подрядчики и поставщики',
  finance: 'Финансы', schedule: 'График работ', procurement: 'Снабжение',
  quality: 'Контроль качества', client: 'Кабинет клиента', settings: 'Настройки',
};

export const isPageId = (value: string | null): value is PageId =>
  value !== null && Object.hasOwn(pageLabels, value);

export const allowedPages = (role: 'management' | 'foreman' | 'client'): PageId[] => {
  if (role === 'client') return ['client'];
  if (role === 'foreman') return ['overview', 'project', 'tasks', 'schedule', 'procurement', 'quality'];
  return (Object.keys(pageLabels) as PageId[]).filter((page) => page !== 'client');
};

export interface WorkspaceRoute {
  projectId: string | null;
  page: PageId | null;
  entityId: string | null;
  valid: boolean;
}

// Root query links remain supported for notifications and existing bookmarks.
export const readWorkspaceRoute = (pathname: string, search: string): WorkspaceRoute => {
  const params = new URLSearchParams(search);
  if (pathname === '/') {
    const page = params.get('page');
    return {
      projectId: params.get('projectId') === 'ikioma-sales' ? null : params.get('projectId'),
      page: isPageId(page) ? page : null,
      entityId: params.get('entity'),
      valid: (page === null || isPageId(page)) && (!params.get('projectId') || /^[a-zA-Z0-9._:-]{1,100}$/.test(params.get('projectId')!)),
    };
  }
  const match = /^\/projects\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  try {
    const projectId = match ? decodeURIComponent(match[1]) : '';
    const page = match ? match[2] : null;
    return {
      projectId: projectId || null,
      page: isPageId(page) ? page : null,
      entityId: params.get('entity'),
      valid: /^[a-zA-Z0-9._:-]{1,100}$/.test(projectId) && isPageId(page),
    };
  } catch {
    return { projectId: null, page: null, entityId: null, valid: false };
  }
};

export const workspacePath = (projectId: string, page: PageId, entityId?: string | null) =>
  `/projects/${encodeURIComponent(projectId)}/${page}${entityId ? `?entity=${encodeURIComponent(entityId)}` : ''}`;
