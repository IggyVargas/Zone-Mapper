import { ingressAware } from './client';

export type LiveWsMessage =
  | { type: 'subscribed'; deviceId: string; profileId: string; entities: string[]; initialStates?: Record<string, { state: string; attributes: any }>; hasMappings?: boolean }
  | { type: 'state_update'; entityId: string; state: string; attributes?: any; timestamp: number }
  | { type: 'warning'; code: string; message: string; deviceId?: string }
  | { type: 'error'; error: string };

export function connectLiveWs(): WebSocket {
  // ingressAware trata do path dentro do add-on
  const url = ingressAware('api/live/ws');
  // url pode vir como "/api/..." (relative). WebSocket precisa de ws:// + host
  // então usamos window.location para montar:
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const full = url.startsWith('http')
    ? url.replace(/^http/, 'ws')
    : `${proto}//${window.location.host}${url.startsWith('/') ? '' : '/'}${url}`;

  return new WebSocket(full);
}
