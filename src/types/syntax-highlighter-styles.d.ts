/**
 * 运行时的 react-syntax-highlighter 样式子路径（dist/esm/styles/prism）
 * 由 @types/react-syntax-highlighter 未提供类型声明，这里补充环境声明。
 */
declare module 'react-syntax-highlighter/dist/esm/styles/prism' {
  const oneDark: Record<string, React.CSSProperties>;
  const oneLight: Record<string, React.CSSProperties>;
  const prism: Record<string, React.CSSProperties>;
  const okaidia: Record<string, React.CSSProperties>;
  const twilight: Record<string, React.CSSProperties>;
  const coldarkDark: Record<string, React.CSSProperties>;
  export { oneDark, oneLight, prism, okaidia, twilight, coldarkDark };
  const _default: Record<string, Record<string, React.CSSProperties>>;
  export default _default;
}
