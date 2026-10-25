import { useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { ROUTES } from '@/lib/core/constants';
import { useSettingsUiStore } from '@/stores/settingsUiStore';

/**
 * `/settings` 路由的唯一职责：**打开设置弹窗，然后立刻离开这个路由**。
 *
 * 为什么还留着这条路由，而不是从路由表里删掉：
 * 主进程有两处按**路径字符串**发起跳转（托盘菜单「设置」、单实例二次唤起），
 * 它们不知道渲染层现在是弹窗还是页面。保留这条路由当适配层，主进程不用改；
 * 渲染层这边则把「设置」表达成一次状态变更（`openSettings()`），随即重定向回
 * 聊天页——否则会出现「弹窗开着、底下还压着一个空路由页」的怪异栈。
 *
 * 用 `<Navigate replace>` 而非 `navigate()`：历史里不该留下 `/settings` 这一跳，
 * 否则用户按返回键会回到这里、弹窗又被打开一次，看起来像返回失灵。
 */
export function SettingsRoute() {
  const openSettings = useSettingsUiStore((s) => s.openSettings);

  useEffect(() => {
    openSettings();
  }, [openSettings]);

  return <Navigate to={ROUTES.chat} replace />;
}
