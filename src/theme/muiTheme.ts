import { createTheme, type Theme } from '@mui/material/styles';

/** 主题模式 */
export type ThemeMode = 'light' | 'dark';

/**
 * MUI 主题工厂：深色、克制、偏工具型 Agent 客户端；浅色为同风格协调版本。
 */
export function buildMuiTheme(mode: ThemeMode): Theme {
  const palette =
    mode === 'dark'
      ? {
          mode: 'dark' as const,
          // 主色从靛紫(#6366f1)改为灰阶，保持克制、工具感，同时兼容深浅主题
          primary: {
            main: '#e2e8f0',
            light: '#f1f5f9',
            dark: '#94a3b8',
            contrastText: '#0f1115',
          },
          secondary: { main: '#22d3ee' },
          success: { main: '#22c55e' },
          warning: { main: '#f59e0b' },
          error: { main: '#ef4444' },
          info: { main: '#58a6ff' },
          background: {
            default: '#0f1115',
            paper: '#171a21',
          },
          text: {
            primary: '#e6e8eb',
            secondary: '#9aa3af',
          },
          divider: 'rgba(255,255,255,0.08)',
          action: {
            hover: 'rgba(255,255,255,0.06)',
            selected: 'rgba(255,255,255,0.12)',
          },
        }
      : {
          mode: 'light' as const,
          primary: {
            main: '#1f2430',
            light: '#334155',
            dark: '#0f1115',
            contrastText: '#ffffff',
          },
          secondary: { main: '#0e7490' },
          success: { main: '#16a34a' },
          warning: { main: '#d97706' },
          error: { main: '#dc2626' },
          info: { main: '#0969da' },
          background: {
            default: '#f5f7fa',
            paper: '#ffffff',
          },
          text: {
            primary: '#1f2430',
            secondary: '#64748b',
          },
          divider: 'rgba(15, 23, 42, 0.1)',
          action: {
            hover: 'rgba(0,0,0,0.04)',
            selected: 'rgba(0,0,0,0.08)',
          },
        };

  return createTheme({
    palette,
    shape: { borderRadius: 10 },
    typography: {
      fontFamily:
        'Inter, "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      fontSize: 14,
      h4: { fontWeight: 700 },
      h5: { fontWeight: 700 },
      h6: { fontWeight: 600 },
      button: { textTransform: 'none', fontWeight: 600 },
    },
    components: {
      MuiButton: { defaultProps: { disableElevation: true } },
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: { borderRadius: 8 },
        },
      },
      MuiChip: {
        styleOverrides: { root: { borderRadius: 6, fontWeight: 500 } },
      },
    },
  });
}

/** 默认深色主题导出（兼容既有引用） */
export const muiTheme = buildMuiTheme('dark');
