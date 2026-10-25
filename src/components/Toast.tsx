import { create } from 'zustand';
import { Alert, Stack } from '@mui/material';
import { genId } from '@/lib/core/id';

type Severity = 'info' | 'success' | 'error' | 'warning';

interface ToastItem {
  id: string;
  message: string;
  severity: Severity;
}

interface ToastStore {
  items: ToastItem[];
  push: (message: string, severity?: Severity) => void;
  remove: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set, get) => ({
  items: [],
  push: (message, severity = 'info') => {
    const id = genId();
    set((s) => ({ items: [...s.items, { id, message, severity }] }));
    setTimeout(() => get().remove(id), 3500);
  },
  remove: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));

/** 全局轻提示 API */
export const toast = {
  info: (m: string) => useToastStore.getState().push(m, 'info'),
  success: (m: string) => useToastStore.getState().push(m, 'success'),
  error: (m: string) => useToastStore.getState().push(m, 'error'),
  warning: (m: string) => useToastStore.getState().push(m, 'warning'),
};

/** 全局 Toast 容器（固定右上角） */
export function ToastContainer() {
  const items = useToastStore((s) => s.items);
  const remove = useToastStore((s) => s.remove);
  return (
    <Stack
      spacing={1}
      sx={{ position: 'fixed', top: 16, right: 16, zIndex: 2000, maxWidth: 360 }}
    >
      {items.map((it) => (
        <Alert
          key={it.id}
          severity={it.severity}
          variant="filled"
          onClose={() => remove(it.id)}
        >
          {it.message}
        </Alert>
      ))}
    </Stack>
  );
}
