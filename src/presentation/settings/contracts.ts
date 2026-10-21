import type { AppState, UserRole } from '../../entities/index';
import type { RemoteProjectSnapshot } from '../../application';
export type SettingsTab = 'access' | 'dashboard' | 'notifications' | 'integrations';
export type WebAccessStatus = 'not_issued' | 'pending' | 'active' | 'expired' | 'blocked';
export type AccessUser = {
  userId: string;
  web: { status: WebAccessStatus; invitedAt?: string; expiresAt?: string; activatedAt?: string; lastLoginAt?: string };
  telegram: { status: 'connected' | 'not_connected'; boundAt?: string; username?: string };
};
export type AccessSnapshot = { authMode: 'local_password' | 'sites_sso'; users: AccessUser[] };
export type UserProjectAccess = {
  id: string;
  code: string;
  name: string;
  selected: boolean;
  status: WebAccessStatus;
  role: UserRole;
};
export type UserProjectAccessSnapshot = { accountActive: boolean; projects: UserProjectAccess[] };
export type TelegramCandidate = { id: string; title: string; type: string };
export type IntegrationStatus = {
  email: boolean;
  telegram: boolean;
  telegramBot?: boolean;
  telegramBotUsername?: string;
  telegramCommon?: boolean;
  telegramCommonTitle?: string;
  telegramCandidates?: TelegramCandidate[];
  telegramIssue?: string;
  telegramInbound?: boolean;
  telegramBoundUsers?: number;
  telegramPendingMessages?: number;
  telegramDeadMessages?: number;
  telegramLastDeliveryError?: string;
  camera: boolean;
  websiteForm: boolean;
  publicWebsiteForm: boolean;
};

export interface SettingsProps { state: AppState; actor: string; role: UserRole; canManageAccess: boolean; onChange: (next: AppState) => void; onServerSnapshot: (snapshot: RemoteProjectSnapshot) => void }
