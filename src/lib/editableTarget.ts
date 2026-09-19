/**
 * 「焦点是否落在会吞掉按键的输入控件里」——全局键盘处理的前置判断。
 *
 * 单独成模块而不是塞进 `lib/shortcuts`：那一层是**纯字符串逻辑**
 * （注册表 + 键位解析/匹配），不含任何 DOM 引用。原因是它会被非渲染层的
 * 编译单元间接引用到（`lib/constants → types/settings → types` 这条链），
 * 而 electron 的 tsconfig 不加载 DOM 类型库——一旦在这里写 `HTMLElement`，
 * 主进程的类型检查就会报错。
 *
 * 抽出来还有个直接好处：原先 TitleBar 的 Alt+E/Alt+H 与快捷键派发器各写了一份
 * 同样逻辑的判断，两处的「可编辑」定义迟早会漂移。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // 写成 `=== true` 而不是直接返回属性：jsdom 没有实现 `isContentEditable`，
  // 直接返回会让本函数在测试环境里返回 undefined——布尔函数返回 undefined，
  // 调用方 `if (fn())` 恰好也能工作，于是这个不一致会一直藏着。
  return target.isContentEditable === true;
}
