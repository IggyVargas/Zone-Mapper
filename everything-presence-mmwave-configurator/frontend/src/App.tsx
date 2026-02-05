import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
  fetchDevices,
  fetchProfiles,
  fetchSettings,
  updateSettings,
  ingressAware,
} from './api/client';
import { createRoom, fetchRooms } from './api/rooms';
import {
  DiscoveredDevice,
  RoomConfig,
  LiveState,
} from './api/types';
import { ZoneEditorPage } from './pages/ZoneEditorPage';
import { RoomBuilderPage } from './pages/RoomBuilderPage';
import { WizardPage } from './pages/WizardPage';
import { LiveTrackingPage } from './pages/LiveTrackingPage';
import { SettingsPage } from './pages/SettingsPage';
import { DeviceMappingsProvider } from './contexts/DeviceMappingsContext';

function App() {
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [profiles, setProfiles] = useState<{ id: string; label: string }[]>([]);
  const [rooms, setRooms] = useState<RoomConfig[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [view, setView] =
    useState<'dashboard' | 'wizard' | 'zoneEditor' | 'roomBuilder' | 'liveTracking' | 'settings'>(
      'dashboard'
    );

  const [liveState, setLiveState] = useState<LiveState | null>(null);

  // ─────────────────────────────────────────────
  // LOAD INITIAL DATA
  // ─────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const [d, p, r, s] = await Promise.all([
        fetchDevices(),
        fetchProfiles(),
        fetchRooms(),
        fetchSettings(),
      ]);
      setDevices(d.devices);
      setProfiles(p.profiles);
      setRooms(r.rooms);

      if (s.settings.defaultRoomId) {
        setSelectedRoomId(s.settings.defaultRoomId);
        const room = r.rooms.find(x => x.id === s.settings.defaultRoomId);
        if (room?.profileId) setSelectedProfileId(room.profileId);
      }
    })();
  }, []);

  const selectedRoom = useMemo(
    () => rooms.find(r => r.id === selectedRoomId),
    [rooms, selectedRoomId]
  );
  const selectedProfile = useMemo(
    () => profiles.find(p => p.id === selectedProfileId),
    [profiles, selectedProfileId]
  );

  // ─────────────────────────────────────────────
  // LIVE WEBSOCKET — FIXED
  // ─────────────────────────────────────────────
  useEffect(() => {
    if (!selectedRoom?.deviceId || !selectedProfile) return;

    const url = ingressAware('api/live/ws');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}${url}`;

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          deviceId: selectedRoom.deviceId,
          profileId: selectedProfile.id,
          entityMappings: selectedRoom.entityMappings,
          entityNamePrefix: selectedRoom.entityNamePrefix,
        })
      );
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);

      // 🔥 INIT STATE PROPERLY
      if (msg.type === 'subscribed') {
        const base: LiveState = {
          deviceId: msg.deviceId,
          profileId: msg.profileId,
          timestamp: Date.now(),
          targets: [],
        };

        if (msg.initialStates) {
          Object.entries(msg.initialStates).forEach(([id, v]: any) => {
            const m = id.match(/target_(\d+)_(x|y)/);
            if (!m) return;

            const tid = Number(m[1]);
            const field = m[2];

            let t = base.targets!.find(x => x.id === tid);
            if (!t) {
              t = { id: tid, x: null, y: null };
              base.targets!.push(t);
            }
            (t as any)[field] = parseFloat(v.state);
          });
        }

        setLiveState(base);
      }

      // 🔥 REAL UPDATES
      if (msg.type === 'state_update') {
        setLiveState(prev => {
          if (!prev) {
            return {
              deviceId: selectedRoom.deviceId!,
              profileId: selectedProfile.id,
              timestamp: Date.now(),
              targets: [],
            };
          }

          const next = { ...prev, timestamp: msg.timestamp };

          const m = msg.entityId.match(/target_(\d+)_(x|y|distance|speed|angle|active)/);
          if (!m) return next;

          const tid = Number(m[1]);
          const field = m[2];

          if (!next.targets) next.targets = [];

          let t = next.targets.find(x => x.id === tid);
          if (!t) {
            t = { id: tid, x: null, y: null };
            next.targets.push(t);
          }

          if (field === 'active') {
            t.active = msg.state === 'on';
          } else {
            const v = parseFloat(msg.state);
            (t as any)[field] = Number.isFinite(v) ? v : null;
          }

          return next;
        });
      }
    };

    return () => ws.close();
  }, [selectedRoom, selectedProfile]);

  // ─────────────────────────────────────────────
  // COORD TRANSFORM
  // ─────────────────────────────────────────────
  const deviceToRoom = useCallback(
    (x: number, y: number) => {
      if (!selectedRoom?.devicePlacement) return { x, y };

      const { x: dx, y: dy, rotationDeg = 0 } = selectedRoom.devicePlacement;
      const a = (rotationDeg * Math.PI) / 180;
      return {
        x: x * Math.cos(a) - y * Math.sin(a) + dx,
        y: x * Math.sin(a) + y * Math.cos(a) + dy,
      };
    },
    [selectedRoom]
  );

  const targetPositions = useMemo(() => {
    if (!liveState?.targets) return [];
    return liveState.targets
      .filter(t => t.x !== null && t.y !== null && t.active !== false)
      .map(t => {
        const p = deviceToRoom(t.x!, t.y!);
        return { id: t.id, x: p.x, y: p.y, distance: t.distance ?? null, speed: t.speed ?? null, angle: t.angle ?? null };
      });
  }, [liveState, deviceToRoom]);

  return (
    <DeviceMappingsProvider>
      <LiveTrackingPage
        onNavigate={setView}
        initialRoomId={selectedRoomId}
        initialProfileId={selectedProfileId}
        liveState={liveState}
        targetPositions={targetPositions}
        onRoomChange={(r, p) => {
          setSelectedRoomId(r);
          setSelectedProfileId(p);
        }}
      />
    </DeviceMappingsProvider>
  );
}

export default App;
