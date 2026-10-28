import type { FastifyRequest } from 'fastify';
import type { AdminAccess, AdminAuthMode, AdminResource, Application, AppRegistration, AuditEvent, Connection, Installation, Registration, Tenant } from '../../../packages/contracts/src/index.js';
import type { AdminPrincipal } from './admin-auth.js';
import type { Bridge } from './bridge.js';
import { assert } from './errors.js';
import { configuredAdminMode } from './config.js';

interface Summary { id: string; installationId: string; createdAt: string }
interface CDS { id: string; installationId: string }

/** Explicit grants apply to both axes; an empty assignment grants no access. */
export class AdminPolicy {
  readonly platformAdmin: boolean;
  readonly canWrite: boolean;
  private constructor(readonly principal: AdminPrincipal,
    readonly tenants: Tenant[], readonly applications: Application[], readonly connections: Connection[],
    readonly registrations: Registration[], readonly parents: AppRegistration[], readonly installations: Installation[],
    readonly summaries: Summary[], readonly cds: CDS[], readonly authMode: AdminAuthMode | 'demo') {
    this.platformAdmin = principal.identity.role === 'platform_admin';
    this.canWrite = principal.identity.role !== 'viewer';
  }
  static async load(bridge: Bridge, principal: AdminPrincipal) {
    const [tenants, applications, connections, registrations, parents, installations, summaries, cds] = await Promise.all([
      bridge.repo.list<Tenant>('tenants'), bridge.repo.list<Application>('applications'), bridge.repo.list<Connection>('connections'),
      bridge.repo.list<Registration>('registrations'), bridge.repo.list<AppRegistration>('app_registrations'), bridge.repo.list<Installation>('installations'),
      bridge.repo.list<Summary>('activations'), bridge.repo.list<CDS>('cds_services'),
    ]);
    return new AdminPolicy(principal, tenants, applications, connections, registrations, parents, installations, summaries, cds, configuredAdminMode(bridge.config));
  }
  organization(id: string) { return this.platformAdmin || this.principal.identity.organizationIds.includes(id); }
  application(id: string) { return this.platformAdmin || this.principal.identity.applicationIds.includes(id); }
  installation(value: Installation) { return this.organization(value.tenantId) && this.application(value.applicationId); }
  private parentVisible(value: AppRegistration) {
    return this.platformAdmin || value.applicationIds.some(id => this.application(id))
      || this.installations.some(i => i.appRegistrationId === value.id && this.installation(i));
  }
  private registrationVisible(id: string) {
    if (this.platformAdmin) return true;
    const bound = this.installations.filter(i => i.registrationId === id);
    if (bound.length) return bound.some(i => this.installation(i));
    return this.parents.some(p => p.clientRegistrationIds.includes(id) && p.applicationIds.length > 0 && p.applicationIds.every(app => this.application(app)));
  }
  private allBindingsVisible(predicate: (i: Installation) => boolean) {
    return this.installations.filter(predicate).every(i => this.installation(i));
  }
  private clientManageable(id: string) {
    const parents = this.parents.filter(p => p.clientRegistrationIds.includes(id));
    return this.registrationVisible(id) && this.allBindingsVisible(i => i.registrationId === id)
      && parents.length > 0 && parents.every(p => p.applicationIds.length > 0 && p.applicationIds.every(app => this.application(app))
        && this.allBindingsVisible(i => i.appRegistrationId === p.id));
  }
  canRead(resource: AdminResource, id: string): boolean {
    if (this.platformAdmin) return true;
    switch (resource) {
      case 'tenants': return this.organization(id);
      case 'applications': return this.application(id);
      case 'installations': return this.installations.some(i => i.id === id && this.installation(i));
      case 'connections': return this.connections.some(c => c.id === id && this.organization(c.tenantId)
        && (!this.installations.some(i => i.connectionId === id) || this.installations.some(i => i.connectionId === id && this.installation(i))));
      case 'registrations': return this.registrationVisible(id);
      case 'appRegistrations': return this.parents.some(p => p.id === id && this.parentVisible(p));
      case 'activations': return this.summaries.some(s => s.id === id && this.canRead('installations', s.installationId));
      case 'cdsServices': return this.cds.some(s => s.id === id && this.canRead('installations', s.installationId));
    }
  }
  canManage(resource: AdminResource, id: string): boolean {
    if (!this.canWrite) return false;
    if (this.platformAdmin) return true;
    if (!this.canRead(resource, id)) return false;
    switch (resource) {
      case 'applications': return this.allBindingsVisible(i => i.applicationId === id);
      case 'connections': return this.allBindingsVisible(i => i.connectionId === id);
      case 'registrations': return this.clientManageable(id);
      case 'appRegistrations': return this.parents.some(p => p.id === id && p.applicationIds.length > 0
        && p.applicationIds.every(app => this.application(app)) && this.allBindingsVisible(i => i.appRegistrationId === id)
        && p.clientRegistrationIds.every(client => this.clientManageable(client)));
      default: return true;
    }
  }
  requireRead(resource: AdminResource, id: string) {
    assert(this.canRead(resource, id), 404, 'resource_not_found', 'This resource is not available in your administrative scope.');
  }
  requireManage(resource: AdminResource, id: string) {
    this.requireRead(resource, id);
    assert(this.canManage(resource, id), 403, 'administrative_access_denied', 'Your role or assignments do not permit this change. Shared configuration requires access to every affected integration.');
  }
  parentProjection(parent: AppRegistration): AppRegistration {
    if (this.platformAdmin) return parent;
    return { ...parent, applicationIds: parent.applicationIds.filter(id => this.application(id)),
      clientRegistrationIds: parent.clientRegistrationIds.filter(id => this.registrationVisible(id)) };
  }
  eventVisible(event: AuditEvent) {
    if (this.platformAdmin) return true;
    if (event.resource) {
      const resource = ({ tenants: 'tenants', applications: 'applications', connections: 'connections', registrations: 'registrations',
        'app-registrations': 'appRegistrations', app_registrations: 'appRegistrations', installations: 'installations',
        activations: 'activations', 'cds-services': 'cdsServices', cds_services: 'cdsServices' } as Record<string, AdminResource>)[event.resource.type];
      if (resource && !this.canRead(resource, event.resource.id)) return false;
      if (!resource && event.resource.type !== 'platforms') return false;
    }
    if (event.installationId) return this.canRead('installations', event.installationId);
    if (event.activationId) return this.canRead('activations', event.activationId);
    if (event.applicationId && !this.application(event.applicationId)) return false;
    if (event.tenantId) return this.organization(event.tenantId);
    if (event.applicationId) return this.application(event.applicationId);
    return event.actor?.id === this.principal.identity.id;
  }
  access(): AdminAccess {
    const ids: Record<AdminResource, { id: string }[]> = { tenants: this.tenants, applications: this.applications, connections: this.connections,
      registrations: this.registrations, appRegistrations: this.parents, installations: this.installations, activations: this.summaries, cdsServices: this.cds };
    return { identity: this.principal.identity, platformAdmin: this.platformAdmin, canWrite: this.canWrite, authMode: this.authMode,
      manageable: Object.fromEntries(Object.entries(ids).map(([resource, values]) => [resource, values.filter(v => this.canManage(resource as AdminResource, v.id)).map(v => v.id)])) as AdminAccess['manageable'] };
  }
  /** Every administrative route is authorized explicitly; new routes fail closed for scoped users. */
  authorize(request: FastifyRequest) {
    if (this.platformAdmin) return;
    const path = new URL(request.url, 'https://admin.invalid').pathname.slice('/api/admin/'.length);
    const [collection, rawId, action] = path.split('/');
    const id = rawId ? decodeURIComponent(rawId) : undefined;
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (write) assert(this.canWrite, 403, 'administrative_access_denied', 'Your administrative role is read-only.');
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    const string = (value: unknown) => typeof value === 'string' ? value : '';
    const resource = ({ tenants: 'tenants', applications: 'applications', connections: 'connections', registrations: 'registrations',
      'app-registrations': 'appRegistrations', installations: 'installations', activations: 'activations', 'cds-services': 'cdsServices' } as Record<string, AdminResource>)[collection ?? ''];
    if (!write) {
      assert(collection !== 'users', 403, 'administrative_access_denied', 'Platform administrator access is required to manage users.');
      if (collection === 'dashboard' && !id && !action) return;
      if (collection === 'platforms' && !action) return;
      assert(resource, 403, 'administrative_access_denied', 'This administrative operation requires platform administrator access.');
      assert(!action || (collection === 'installations' && action === 'worksheet'), 403, 'administrative_access_denied', 'This administrative operation requires platform administrator access.');
      if (id) this.requireRead(resource, id);
      return;
    }
    if (id && resource) {
      const operation = `${request.method} ${collection}/${action ?? ''}`;
      assert(['PATCH app-registrations/', 'POST app-registrations/clients', 'PATCH applications/', 'POST applications/credentials',
        'PATCH tenants/', 'PATCH installations/', 'POST connections/verify', 'POST activations/close'].includes(operation),
      403, 'administrative_access_denied', 'This administrative operation requires platform administrator access.');
      this.requireManage(resource, id);
      if (collection === 'app-registrations' && request.method === 'PATCH' && body.applicationIds !== undefined) {
        assert(Array.isArray(body.applicationIds) && body.applicationIds.length > 0 && body.applicationIds.every(app => this.application(string(app))),
          403, 'administrative_access_denied', 'App registration associations must stay within your assigned applications.');
      }
      if (collection === 'connections' && action === 'verify' && body.registrationId) this.requireRead('registrations', string(body.registrationId));
      return;
    }
    if (collection === 'connections') {
      assert(this.organization(string(body.tenantId)), 403, 'administrative_access_denied', 'Choose an assigned organization.');
      return;
    }
    if (collection === 'app-registrations') {
      assert(Array.isArray(body.applicationIds) && body.applicationIds.length > 0 && body.applicationIds.every(app => this.application(string(app))),
        403, 'administrative_access_denied', 'Choose only assigned applications.');
      assert(body.clientRegistrationIds === undefined || (Array.isArray(body.clientRegistrationIds)
        && body.clientRegistrationIds.every(client => this.canManage('registrations', string(client)))),
      403, 'administrative_access_denied', 'Client profiles must be manageable within your assignments.');
      return;
    }
    if (collection === 'installations') {
      assert(this.organization(string(body.tenantId)) && this.application(string(body.applicationId)), 403, 'administrative_access_denied', 'Choose an assigned organization and application.');
      this.requireRead('connections', string(body.connectionId));
      // A new binding can send confidential client credentials to the selected server.
      // Metadata visibility alone never grants authority to reuse a shared credential.
      this.requireManage('registrations', string(body.registrationId));
      assert(typeof body.appRegistrationId === 'string', 403, 'administrative_access_denied', 'Choose an existing app registration explicitly.');
      this.requireManage('appRegistrations', body.appRegistrationId);
      const parent = this.parents.find(p => p.id === body.appRegistrationId);
      assert(parent?.applicationIds.includes(string(body.applicationId)), 403, 'administrative_access_denied', 'The app registration must already include this application.');
      return;
    }
    if (collection === 'cds-services') { this.requireManage('installations', string(body.installationId)); return; }
    assert(false, 403, 'administrative_access_denied', 'This operation requires a platform administrator.');
  }
}
