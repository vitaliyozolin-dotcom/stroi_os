export type UserRole = 'management' | 'foreman' | 'client';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isOwner: boolean;
}

export type AccountStatus = 'active' | 'invited' | 'disabled';

export interface SystemUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: AccountStatus;
  telegram?: string;
  telegramChatId?: string;
  telegramBoundAt?: string;
  lastActiveAt?: string;
  invitedAt?: string;
  webActivatedAt?: string;
  inviteDelivery?: 'sent' | 'not_configured' | 'failed' | 'draft';
}

export interface NotificationSettings {
  channels: {
    email: boolean;
    telegram: boolean;
    browser: boolean;
  };
  events: {
    financeApproval: boolean;
    supplyRisk: boolean;
    qualityRework: boolean;
    leadWithoutAction: boolean;
    scheduleDelay: boolean;
    taskAssigned: boolean;
    taskOverdue: boolean;
    projectActivity: boolean;
  };
}

export type DashboardWidget = 'project' | 'progress' | 'finance' | 'decisions' | 'cashflow' | 'quality' | 'supply' | 'tasks' | 'activity';

export interface AppSettings {
  schemaVersion?: number;
  users: SystemUser[];
  notifications: NotificationSettings;
  dashboardWidgets: DashboardWidget[];
}
