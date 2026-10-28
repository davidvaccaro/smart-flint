import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditEvent } from '../../../packages/contracts/src/index.js';

/** Bound around each administrative handler, never a process-wide current user. */
export const adminAuditContext = new AsyncLocalStorage<Pick<AuditEvent, 'actor' | 'applicationId' | 'tenantId' | 'resource'>>();
