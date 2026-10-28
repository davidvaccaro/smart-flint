import type { AdminIdentity, AdminResource, Dashboard } from '@smart-flint/contracts';
import type { FormContext, FormKind } from './Forms';

export const roleLabel = (role?: AdminIdentity['role']) => ({ platform_admin: 'Platform administrator', integration_admin: 'Integration administrator', viewer: 'Read-only viewer' }[role || 'viewer']);
export const isPlatformAdmin = (data: Dashboard) => data.access?.platformAdmin === true;
export const canWrite = (data: Dashboard) => data.access?.canWrite === true;
export const canManage = (data: Dashboard, resource: AdminResource, id: string) => isPlatformAdmin(data) || (canWrite(data) && data.access?.manageable[resource]?.includes(id) === true);
export function canCreateForm(data: Dashboard, kind: FormKind, context: FormContext = {}): boolean {
  if (isPlatformAdmin(data)) return true;
  if (!canWrite(data)) return false;
  const identity = data.access!.identity;
  if (['tenant', 'application', 'platform', 'registration'].includes(kind)) return false;
  if (kind === 'connection') return context.tenantId ? identity.organizationIds.includes(context.tenantId) : data.tenants.some(item => identity.organizationIds.includes(item.id));
  if (kind === 'app-registration') return context.applicationId ? identity.applicationIds.includes(context.applicationId) : data.applications.some(item => identity.applicationIds.includes(item.id));
  if (kind === 'registration-client') return !!context.appRegistrationId && canManage(data, 'appRegistrations', context.appRegistrationId);
  if (kind === 'installation') return (!context.applicationId || identity.applicationIds.includes(context.applicationId)) && (!context.tenantId || identity.organizationIds.includes(context.tenantId)) && data.applications.length > 0 && data.tenants.length > 0;
  return false;
}
export const canUseDeveloperLab = (data: Dashboard) => isPlatformAdmin(data) || (canWrite(data) && (data.access?.manageable.installations.length || 0) > 0);
export const readOnlyReason = 'Your role or resource assignment allows viewing this configuration. Ask a platform administrator for access to change it.';
