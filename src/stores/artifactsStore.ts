import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandStorage } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import type { Artifact } from '@/types';

interface ArtifactsState {
  /** 按 sessionId 归档的富产物（供 /artifacts 产物库读取） */
  bySession: Record<string, Artifact[]>;
  recordArtifact: (sessionId: string, artifact: Artifact) => void;
  clearSession: (sessionId: string) => void;
  clearAll: () => void;
}

export const useArtifactsStore = create<ArtifactsState>()(
  persist(
    (set) => ({
      bySession: {},

      recordArtifact: (sessionId, artifact) =>
        set((s) => {
          const list = s.bySession[sessionId] ?? [];
          if (list.some((a) => a.id === artifact.id)) return s;
          return { bySession: { ...s.bySession, [sessionId]: [...list, artifact] } };
        }),

      clearSession: (sessionId) =>
        set((s) => {
          const next = { ...s.bySession };
          delete next[sessionId];
          return { bySession: next };
        }),

      clearAll: () => set({ bySession: {} }),
    }),
    {
      name: STORAGE_KEYS.artifacts,
      storage: zustandStorage,
      partialize: (s) => ({ bySession: s.bySession }),
    },
  ),
);
