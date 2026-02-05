import { v4 as uuidv4 } from 'uuid';
import { logger } from '../logger';
import { EntityRegistryEntry } from './types';
import {
  IHaReadTransport,
  ReadTransportConfig,
  EntityState,
  DeviceRegistryEntry,
  AreaRegistryEntry,
  StateChangeCallback,
  HaTarget,
} from './readTransport';

interface Subscription {
  id: string;
  entityIds: Set<string>;
  callback: StateChangeCallback;
  lastStates: Map<string, EntityState>;
}

/**
 * REST-based read transport for Home Assistant.
 *
 * Provides polling-based state updates as a fallback when
 * WebSocket is unavailable.
 */
export class RestReadTransport implements IHaReadTransport {
  readonly activeTransport = 'rest' as const;

  private readonly config: ReadTransportConfig;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly pollingInterval: number;

  private subscriptions = new Map<string, Subscription>();
  private pollingTimer?: NodeJS.Timeout;
  private _isConnected = false;

  constructor(config: ReadTransportConfig, pollingInterval: number = 1000) {
    this.config = config;
    this.pollingInterval = pollingInterval;

    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    if (!this.baseUrl.endsWith('/api')) {
      this.baseUrl = this.baseUrl + '/api';
    }
    this.token = config.token;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    };
  }

  private buildUrl(path: string): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${normalized}`;
  }

  // ─────────────────────────────────────────────────────────────────
  // Connection Management
  // ─────────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    const url = this.buildUrl('/');
    const res = await fetch(url, { headers: this.headers });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`REST API health check failed: ${res.status} - ${text}`);
    }

    this._isConnected = true;
    logger.info('RestReadTransport: Connected');
  }

  disconnect(): void {
    this.stopPolling();
    this._isConnected = false;
  }

  async waitUntilReady(): Promise<void> {
    if (!this._isConnected) {
      await this.connect();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // State Queries
  // ─────────────────────────────────────────────────────────────────

  async getState(entityId: string): Promise<EntityState | null> {
    try {
      const url = this.buildUrl(`/states/${entityId}`);
      const res = await fetch(url, { headers: this.headers });
      if (!res.ok) return null;
      return (await res.json()) as EntityState;
    } catch {
      return null;
    }
  }

  async getStates(entityIds: string[]): Promise<Map<string, EntityState>> {
    const result = new Map<string, EntityState>();
    const allStates = await this.getAllStates();
    const wanted = new Set(entityIds);

    for (const s of allStates) {
      if (wanted.has(s.entity_id)) {
        result.set(s.entity_id, s);
      }
    }

    return result;
  }

  async getAllStates(): Promise<EntityState[]> {
    try {
      const url = this.buildUrl('/states');
      const res = await fetch(url, { headers: this.headers });
      if (!res.ok) return [];
      return (await res.json()) as EntityState[];
    } catch {
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Subscriptions (Polling)
  // ─────────────────────────────────────────────────────────────────

  subscribeToStateChanges(entityIds: string[], callback: StateChangeCallback): string {
    const id = uuidv4();

    this.subscriptions.set(id, {
      id,
      entityIds: new Set(entityIds),
      callback,
      lastStates: new Map(),
    });

    this.startPolling();
    return id;
  }

  unsubscribe(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId);
    if (this.subscriptions.size === 0) {
      this.stopPolling();
    }
  }

  unsubscribeAll(): void {
    this.subscriptions.clear();
    this.stopPolling();
  }

  private startPolling(): void {
    if (this.pollingTimer) return;

    this.pollingTimer = setInterval(() => {
      this.pollStates().catch((err) =>
        logger.error({ err }, 'RestReadTransport: Polling error')
      );
    }, this.pollingInterval);

    this.pollStates().catch(() => {});
  }

  private stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }

  private async pollStates(): Promise<void> {
    if (this.subscriptions.size === 0) return;

    const allEntityIds = new Set<string>();
    for (const sub of this.subscriptions.values()) {
      if (sub.entityIds.size === 0) {
        allEntityIds.clear();
        break;
      }
      sub.entityIds.forEach((id) => allEntityIds.add(id));
    }

    const states =
      allEntityIds.size === 0
        ? await this.getAllStates()
        : Array.from((await this.getStates([...allEntityIds])).values());

    for (const sub of this.subscriptions.values()) {
      const relevant =
        sub.entityIds.size === 0
          ? states
          : states.filter((s) => sub.entityIds.has(s.entity_id));

      for (const newState of relevant) {
        const oldState = sub.lastStates.get(newState.entity_id);

        if (!oldState || this.stateChanged(oldState, newState)) {
          sub.callback(newState.entity_id, newState, oldState ?? null);
        }

        sub.lastStates.set(newState.entity_id, newState);
      }
    }
  }

  /**
   * IMPORTANT:
   * HA updates mmWave tracking via attributes WITHOUT changing state or last_updated
   */
  private stateChanged(oldState: EntityState, newState: EntityState): boolean {
    if (oldState.state !== newState.state) return true;
    if (oldState.last_updated !== newState.last_updated) return true;

    const oldAttrs = JSON.stringify(oldState.attributes ?? {});
    const newAttrs = JSON.stringify(newState.attributes ?? {});

    return oldAttrs !== newAttrs;
  }
}
