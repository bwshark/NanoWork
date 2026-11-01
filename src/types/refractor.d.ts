/**
 * `refractor` 是 `react-syntax-highlighter` 的 Prism 语法后端，包本身不带类型声明。
 *
 * 为什么只声明一个方法：运行时代码**不 import** 它，唯一的使用点是
 * `tests/lib/artifact/fileType.test.ts` —— 用来验证「归一化产出（如 `markup`）
 * 高亮库是否真的认得」，比只检查我们自己的白名单是否抄了这个名字可靠。
 * 把整个 refractor 类型面搬进来（上百个语言定义）没有任何收益。
 */
declare module 'refractor' {
  interface Refractor {
    /** 该语言名（含 Prism 的别名，如 `html` → `markup`）是否已注册 */
    registered(name: string): boolean;
  }
  const refractor: Refractor;
  export default refractor;
}
