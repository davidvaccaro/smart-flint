import type { AppRegistration, Application, Connection, EHRPlatform, Installation, Registration, Vendor } from '../../../packages/contracts/src/index.js';
import { digest, type Repository } from '../../../packages/storage/src/index.js';
import { assert } from './errors.js';

export const defaultPlatformId = (vendor: Vendor) => `platform_${vendor}`;

/** These are adapter metadata, never demo tenants, credentials, or trusted FHIR hosts. */
const platformCatalog: Omit<EHRPlatform, 'createdAt'>[] = [
  { id: 'platform_epic', name: 'Epic', vendor: 'epic', description: 'Epic SMART on FHIR integrations.', documentationUrl: 'https://fhir.epic.com/' },
  { id: 'platform_oracle', name: 'Oracle Health', vendor: 'oracle', description: 'Oracle Health (Cerner) SMART on FHIR integrations.', documentationUrl: 'https://docs.oracle.com/en/industries/health/' },
  { id: 'platform_meditech', name: 'MEDITECH', vendor: 'meditech', description: 'MEDITECH SMART on FHIR integrations.', documentationUrl: 'https://ehr.meditech.com/' },
  { id: 'platform_generic', name: 'Other FHIR platform', vendor: 'generic', description: 'Standards-based SMART on FHIR integrations and custom platforms.' },
];

export async function resolvePlatform(repo: Repository, platformId: string | undefined, vendor?: Vendor): Promise<EHRPlatform> {
  const platform = await repo.get<EHRPlatform>('platforms', platformId ?? defaultPlatformId(vendor ?? 'generic'));
  assert(platform, 404, 'platform_not_found', 'The EHR platform does not exist.');
  assert(vendor === undefined || vendor === platform.vendor, 409, 'platform_vendor_mismatch', 'The platform and adapter vendor must agree.');
  return platform;
}

export async function validateAppRegistration(repo: Repository, parent: AppRegistration, application: Application, connection: Connection, registration: Registration): Promise<void> {
  const platform = await resolvePlatform(repo, connection.platformId, connection.vendor);
  assert(parent.platformId === platform.id, 409, 'platform_mismatch', 'The app registration and organization connection must use the same EHR platform.');
  assert(parent.applicationIds.includes(application.id), 409, 'application_mismatch', 'This app registration is not associated with the selected application.');
  assert(parent.clientRegistrationIds.includes(registration.id), 409, 'registration_mismatch', 'Select an OAuth client profile belonging to this app registration.');
  assert(!registration.platformId || registration.platformId === platform.id, 409, 'platform_mismatch', 'The OAuth client profile belongs to another EHR platform.');
  assert(registration.vendor === 'generic' || connection.vendor === 'generic' || registration.vendor === connection.vendor, 409, 'vendor_mismatch', 'The registration and connection use different vendor profiles.');
  assert(!registration.environment || registration.environment === 'unspecified' || registration.environment === connection.environment,
    409, 'environment_mismatch', 'The OAuth client profile and connection must use the same environment.');
}

/** Legacy callers still send a client profile ID. Bind that existing profile, never copy its credentials. */
export async function legacyAppRegistration(repo: Repository, application: Application, connection: Connection, registration: Registration): Promise<AppRegistration> {
  const platform = await resolvePlatform(repo, connection.platformId, connection.vendor);
  return repo.withLock(`registry:legacy-parent:${registration.id}:${platform.id}`, async () => {
    const parents = await repo.list<AppRegistration>('app_registrations');
    const existing = parents.find(parent => parent.platformId === platform.id && parent.clientRegistrationIds.includes(registration.id) && parent.applicationIds.includes(application.id));
    if (existing) return existing;
    const parentId = `appreg_${digest(`${registration.id}:${platform.id}`).slice(0, 32)}`;
    // The deterministic parent represents the original shared client/platform grouping.
    const grouped = parents.find(parent => parent.id === parentId);
    const unassigned = parents.find(parent => parent.platformId === platform.id && parent.clientRegistrationIds.includes(registration.id) && parent.applicationIds.length === 0);
    const parent: AppRegistration = grouped ?? unassigned ?? {
      id: parentId, name: registration.name, platformId: platform.id, applicationIds: [],
      audience: 'unspecified', clientRegistrationIds: [registration.id], createdAt: registration.createdAt,
    };
    assert(parent.platformId === platform.id && parent.clientRegistrationIds.includes(registration.id), 409, 'registration_mismatch', 'The legacy registration association is inconsistent.');
    return repo.put('app_registrations', { ...parent, applicationIds: [...new Set([...parent.applicationIds, application.id])] });
  });
}

/** Additive, repeatable projection of the original registry into the app-centric model. */
export async function migrateRegistry(repo: Repository): Promise<void> {
  await repo.withLock('registry:relations', async () => {
    const createdAt = new Date().toISOString();
    for (const platform of platformCatalog) {
      if (!await repo.get('platforms', platform.id)) await repo.put('platforms', { ...platform, createdAt });
    }
    const [connections, registrations, installations, applications] = await Promise.all([
      repo.list<Connection>('connections'), repo.list<Registration>('registrations'),
      repo.list<Installation>('installations'), repo.list<Application>('applications'),
    ]);
    const connectionMap = new Map<string, Connection>();
    for (const connection of connections) {
      const migrated = connection.platformId ? connection : { ...connection, platformId: defaultPlatformId(connection.vendor) };
      if (!connection.platformId) await repo.put('connections', migrated);
      connectionMap.set(migrated.id, migrated);
    }
    const appMap = new Map(applications.map(application => [application.id, application]));
    const regMap = new Map(registrations.map(registration => [registration.id, registration]));
    const usedPlatforms = new Map<string, Set<string>>();
    for (const installation of installations) {
      const connection = connectionMap.get(installation.connectionId);
      const registration = regMap.get(installation.registrationId);
      const application = appMap.get(installation.applicationId);
      if (!connection || !registration || !application) continue; // Existing incomplete records remain reviewable.
      const platforms = usedPlatforms.get(registration.id) ?? new Set<string>();
      platforms.add(connection.platformId!); usedPlatforms.set(registration.id, platforms);
      if (!installation.appRegistrationId) {
        const parent = await legacyAppRegistration(repo, application, connection, registration);
        await repo.put('installations', { ...installation, appRegistrationId: parent.id });
      }
    }
    for (const registration of registrations) {
      const platforms = usedPlatforms.get(registration.id);
      // A shared legacy mock/client can span platforms. Keep that explicit instead of assigning it incorrectly.
      const platformId = registration.platformId ?? (registration.vendor === 'generic' ? undefined : !platforms?.size ? defaultPlatformId(registration.vendor) : platforms.size === 1 ? [...platforms][0] : undefined);
      if (registration.platformId !== platformId || registration.environment === undefined) {
        await repo.put('registrations', { ...registration, ...(platformId ? { platformId } : {}), environment: registration.environment ?? 'unspecified' });
      }
      if (!platforms?.size && !(await repo.list<AppRegistration>('app_registrations')).some(parent => parent.clientRegistrationIds.includes(registration.id))) {
        const unassignedPlatformId = platformId ?? defaultPlatformId(registration.vendor);
        await repo.put<AppRegistration>('app_registrations', {
          id: `appreg_${digest(`${registration.id}:${unassignedPlatformId}`).slice(0, 32)}`, name: registration.name,
          platformId: unassignedPlatformId, applicationIds: [], audience: 'unspecified', clientRegistrationIds: [registration.id], createdAt: registration.createdAt,
        });
      }
    }
  });
}
