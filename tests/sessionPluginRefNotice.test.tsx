/**
 * 「会话引用的插件版本本机缺失」提示条（FR-3.9 ①）的渲染契约。
 *
 * 纯函数层（`collectMissingSessionPluginRefs`）算得出缺失不等于**界面会说出来**——
 * 该函数此前正是因为没人调它而一直是死代码。这里把它接到真实渲染上，
 * 钉住「有缺失要看得见、没缺失不能打扰」两件事。
 */

import { ThemeProvider } from "@mui/material";
import { afterEach, describe, expect, it } from "vitest";

import { SessionPluginRefNotice } from "@/pages/plugins/SessionPluginRefNotice";
import { muiTheme } from "@/theme/muiTheme";
import type { MissingSessionPluginRef } from "@/lib/agent/sessionPluginRefs";
import { mount, unmount } from "./helpers/reactMount";

afterEach(() => unmount());

function rows(count: number): MissingSessionPluginRef[] {
  return Array.from({ length: count }, (_, i) => ({
    sessionId: `s${i}`,
    sessionTitle: `会话 ${i}`,
    plugin: `plugin-${i}`,
    version: `0.1.${i}`,
  }));
}

function notice(): Element | null {
  return document.querySelector('[data-testid="session-plugin-ref-notice"]');
}

describe("SessionPluginRefNotice", () => {
  it("没有缺失时不渲染（不能变成常驻噪音）", () => {
    mount(
      <ThemeProvider theme={muiTheme}>
        <SessionPluginRefNotice rows={[]} />
      </ThemeProvider>,
    );
    expect(notice()).toBeNull();
  });

  it("有缺失时列出插件@版本与会话标题，并报出条数", () => {
    mount(
      <ThemeProvider theme={muiTheme}>
        <SessionPluginRefNotice
          rows={[
            {
              sessionId: "s1",
              sessionTitle: "昨天那条分析",
              plugin: "demo",
              version: "0.1.9",
            },
          ]}
        />
      </ThemeProvider>,
    );

    const el = notice();
    expect(el).not.toBeNull();
    const text = el?.textContent ?? "";
    expect(text).toContain("1 条会话");
    expect(text).toContain("demo@0.1.9");
    expect(text).toContain("昨天那条分析");
  });

  it("多条时逐条列出，条数随行数变化", () => {
    mount(
      <ThemeProvider theme={muiTheme}>
        <SessionPluginRefNotice rows={rows(3)} />
      </ThemeProvider>,
    );

    const text = notice()?.textContent ?? "";
    expect(text).toContain("3 条会话");
    for (const row of rows(3)) {
      expect(text).toContain(`${row.plugin}@${row.version}`);
    }
  });
});
