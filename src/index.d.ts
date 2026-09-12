import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostPolicy, HostPolicyObservation, ReferenceHost } from '@aikdna/kdna-web-server';
import type { ReadCallResult } from '@aikdna/kdna-core';
export interface RemoteReadOptions<C = unknown> {
  assetBytes: Uint8Array;
  bindingId: string;
  authorizationDomainId: string;
  verifyContext?: (context: C) => boolean | Promise<boolean>;
  resolveContext?: (request: IncomingMessage) => C | Promise<C>;
  observePolicy?: (observation: HostPolicyObservation<C>) => HostPolicy | null | Promise<HostPolicy | null>;
  hostId?: string;
  clock?: () => number;
  ttlMs?: number;
  maxReads?: number;
  maxInputBytes?: number;
  maxResponseBytes?: number;
  admissionResponseBytes?: number;
  policyTimeoutMs?: number;
  maxRequestBytes?: number;
  requestTimeoutMs?: number;
  deliveryTimeoutMs?: number;
}
export interface RemoteReadHandler {
  (request: IncomingMessage, response: ServerResponse): Promise<ReadCallResult | undefined>;
  dispose(): void;
  retentionState(): ReturnType<ReferenceHost['retentionState']>;
}
export function createRemoteReadHandler<C = unknown>(options: RemoteReadOptions<C>): RemoteReadHandler;
