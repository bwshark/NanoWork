/**
 * 产物正文的**类型真相**：围栏语言名 → 高亮语言 / 下载扩展名 / MIME。
 *
 * ## 为什么围栏语言必须归一化
 *
 * 围栏语言是**模型自由写的文本**，不是受控枚举。本项目自己就约定了两个产品围栏
 * （`nanowork-expert` / `nanowork-expert-team`，内容是 JSON，见
 * `lib/agent/expertBlueprint.ts`），它们的名字当然不在任何高亮器的语法表里。
 *
 * 把这种名字原样丢给 Prism 的症状是**静默降级**：不报错、不着色，整块代码白得像
 * 普通文本，用户只会怀疑「高亮坏了」（2026-11-01 截图）。`ts` / `yml` / `py`
 * 这类常见简写同样不能想当然 —— 它们不是 Prism 的注册名。
 *
 * ## 为什么下载扩展名也在这里
 *
 * 原先下载一律 `new Blob(content, { type: 'text/plain' })`，文件名直接用产物标题
 * （`代码块 (json) 1`，没有扩展名）→ 浏览器补 `.txt`：一份 JSON 片段存出来之后
 * 编辑器不认、双击不开。扩展名与高亮语言本来就是同一件事的两种用法（「这段正文
 * 是什么语言」），拆两处必然漂移，故在这里一次算完，渲染器只负责落盘。
 *
 * 纯函数、无 store / platform 依赖：`MarkdownRenderer` 的懒加载分包与
 * `artifactExtractor` 的主包都能安全引用。
 */

import { EXPERT_BLUEPRINT_LANG, EXPERT_TEAM_BLUEPRINT_LANG } from '@/lib/agent/expertBlueprint';
import { fileBaseName, fileExtension } from './fileArtifact';
import type { Artifact } from '@/types';

/**
 * Prism 真正注册过的语言 id（`react-syntax-highlighter` 的 prism 全量构建）。
 *
 * 清单取自 `node_modules/react-syntax-highlighter/dist/esm/languages/prism/` 的文件名。
 * 为什么要抄一份：判断「这个名字高亮器认不认」必须**不引任何依赖**（主包里的
 * `artifactExtractor` 也要用它决定下载扩展名），所以不能 `import` Prism 反查。
 * 名字漂移的后果是可控的 —— 清单里多出来的名字只会退回纯文本，不会报错。
 */
const PRISM_LANGUAGES = new Set(`abap abnf actionscript ada agda al antlr4 apacheconf apex apl applescript aql arduino arff armasm arturo asciidoc asm6502 asmatmel aspnet autohotkey autoit avisynth avro-idl awk bash basic batch bbcode bbj bicep birb bison bnf bqn brainfuck brightscript bro bsl c cfscript chaiscript cil cilkc cilkcpp clike clojure cmake cobol coffeescript concurnas cooklang coq core cpp crystal csharp cshtml csp css css-extras csv cue cypher d dart dataweave dax dhall diff django dns-zone-file docker dot ebnf editorconfig eiffel ejs elixir elm erb erlang etlua excel-formula factor false firestore-security-rules flow fortran fsharp ftl gap gcode gdscript gedcom gettext gherkin git glsl gml gn go go-module gradle graphql groovy haml handlebars haskell haxe hcl hlsl hoon hpkp hsts http ichigojam icon icu-message-format idris iecst ignore index inform7 ini io j java javadoc javadoclike javascript javastacktrace jexl jolie jq js-extras js-templates jsdoc json json5 jsonp jsstacktrace jsx julia keepalived keyman kotlin kumir kusto latex latte less lilypond linker-script liquid lisp livescript llvm log lolcode lua magma makefile markdown markup markup-templating mata matlab maxscript mel mermaid metafont mizar mongodb monkey moonscript n1ql n4js nand2tetris-hdl naniscript nasm neon nevod nginx nim nix nsis objectivec ocaml odin opencl openqasm oz parigp parser pascal pascaligo pcaxis peoplecode perl php php-extras phpdoc plant-uml plsql powerquery powershell processing prolog promql properties protobuf psl pug puppet pure purebasic purescript python q qml qore qsharp r racket reason regex rego renpy rescript rest rip roboconf robotframework ruby rust sas sass scala scheme scss shell-session smali smalltalk smarty sml solidity solution-file soy sparql splunk-spl sqf sql squirrel stan stata stylus supercollider supported-languages swift systemd t4-cs t4-templating t4-vb tap tcl textile toml tremor tsx tt2 turtle twig typescript typoscript unrealscript uorazor uri v vala vbnet velocity verilog vhdl vim visual-basic warpscript wasm web-idl wgsl wiki wolfram wren xeora xml-doc xojo xquery yaml yang zig`.split(' '));

/** 常见简写 / 俗名 → Prism 注册名（`null` 表示「明确要纯文本」） */
const LANGUAGE_ALIASES: Record<string, string | null> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  py3: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  yml: 'yaml',
  md: 'markdown',
  // ⚠️ `html` **不是** Prism 的注册名（Prism 的叫 `markup`，`html` 只是它的别名）。
  // 漏这两条时 `.html` 产物 / ```html 围栏会走到「不认识 → undefined → 纯文本」，
  // 症状是源码视图整屏白字（2026-11-01 用户截图）。别把它当成「已注册」放过。
  html: 'markup',
  htm: 'markup',
  xhtml: 'markup',
  xml: 'markup',
  svg: 'markup',
  ps1: 'powershell',
  pwsh: 'powershell',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  kt: 'kotlin',
  rs: 'rust',
  rb: 'ruby',
  golang: 'go',
  jsonc: 'json',
  'obj-c': 'objectivec',
  'objc': 'objectivec',
  viml: 'vim',
  dockerfile: 'docker',
  // 明确「就要纯文本」：交给高亮器反而会打一堆 unknown language 警告
  text: null,
  txt: null,
  plaintext: null,
  plain: null,
  // 产品围栏：内容约定是 JSON（见 `lib/agent/expertBlueprint.ts` 的 schema 说明）
  [EXPERT_BLUEPRINT_LANG]: 'json',
  [EXPERT_TEAM_BLUEPRINT_LANG]: 'json',
};

/** 高亮语言 → 产物落盘时的扩展名（只列产物真会产出的类别） */
const LANGUAGE_EXTENSION: Record<string, string> = {
  json: 'json',
  json5: 'json5',
  jsonp: 'jsonp',
  javascript: 'js',
  jsx: 'jsx',
  typescript: 'ts',
  tsx: 'tsx',
  python: 'py',
  bash: 'sh',
  'shell-session': 'sh',
  powershell: 'ps1',
  markdown: 'md',
  // 只有 `markup`（html 归一化后就叫这个名字，见上面的别名表）
  markup: 'html',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  yaml: 'yml',
  toml: 'toml',
  ini: 'ini',
  properties: 'properties',
  sql: 'sql',
  graphql: 'graphql',
  diff: 'diff',
  makefile: 'mk',
  docker: 'dockerfile',
  mermaid: 'mmd',
  csv: 'csv',
  java: 'java',
  kotlin: 'kt',
  swift: 'swift',
  dart: 'dart',
  go: 'go',
  rust: 'rs',
  csharp: 'cs',
  cpp: 'cpp',
  c: 'c',
  php: 'php',
  ruby: 'rb',
  lua: 'lua',
  r: 'r',
  objectivec: 'm',
  matlab: 'm',
  protobuf: 'proto',
  latex: 'tex',
  nginx: 'conf',
  http: 'http',
  log: 'log',
};

/**
 * 扩展名 → MIME（只覆盖本模块能派生的类型）。
 *
 * 与 `lib/artifact/attachments.ts` 的 `EXT_META` 同源但**不共用**：那张表要
 * `import { platform }`（附件读写走平台层），而本模块要被 `MarkdownRenderer`
 * 的懒加载分包引用 —— 为了一个 MIME 字符串把平台层牵进分包不值得。
 * 两处都只覆盖「正文类 / 图片 / 视频」的少量扩展名，冲突面几乎为零。
 */
const EXT_MIME: Record<string, string> = {
  json: 'application/json',
  json5: 'application/json5',
  jsonp: 'application/javascript',
  js: 'text/javascript',
  jsx: 'text/jsx',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  html: 'text/html',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  css: 'text/css',
  scss: 'text/x-scss',
  less: 'text/x-less',
  md: 'text/markdown',
  yml: 'application/yaml',
  yaml: 'application/yaml',
  toml: 'application/toml',
  csv: 'text/csv',
  sql: 'application/sql',
  diff: 'text/x-diff',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

/** 正文看起来就是 JSON 吗（只在语言名不认识时才值得一试） */
function looksLikeJson(content: string | undefined): boolean {
  if (!content) return false;
  const head = content.trimStart()[0];
  if (head !== '{' && head !== '[') return false;
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

/**
 * 围栏语言 → 高亮语言（Prism 注册名）。
 *
 * 三级判据，逐级放宽：
 * 1. 别名表（`ts` → `typescript`、产品围栏 → `json`）；
 * 2. Prism 注册名原样通过；
 * 3. 都不认识 → **按内容嗅探**（能 `JSON.parse` 就是 json），否则 `undefined`
 *    （渲染层退回纯文本）。
 *
 * 第 3 级是这次 bug 的兜底：模型写 `nanowork-expert`、`xx-config` 之类自造名字时，
 * 靠内容而不是靠名字着色，至少不会一屏白字。
 */
export function normalizeCodeLanguage(
  language?: string,
  content?: string,
): string | undefined {
  const key = (language ?? '').trim().toLowerCase().replace(/^language-/, '');
  if (key === '') return looksLikeJson(content) ? 'json' : undefined;
  if (key in LANGUAGE_ALIASES) {
    const aliased = LANGUAGE_ALIASES[key];
    return aliased === null ? undefined : aliased;
  }
  if (PRISM_LANGUAGES.has(key)) return key;
  return looksLikeJson(content) ? 'json' : undefined;
}

/** 高亮语言 → 落盘扩展名（不认识就 `.txt`，与纯文本一致） */
export function extensionForLanguage(language?: string, content?: string): string {
  const normalized = normalizeCodeLanguage(language, content);
  if (!normalized) return 'txt';
  return LANGUAGE_EXTENSION[normalized] ?? normalized;
}

/** 扩展名 → MIME（默认 `text/plain`，宁可保守也别给错类型） */
export function mimeForExtension(extension: string): string {
  return EXT_MIME[extension.toLowerCase()] ?? 'text/plain';
}

/** 产物类别 → 扩展名；`code` 走语言映射，其余按类别固定 */
function extensionForArtifact(artifact: Artifact): string {
  switch (artifact.type) {
    case 'html':
      return 'html';
    case 'svg':
      return 'svg';
    case 'markdown':
      return 'md';
    case 'mermaid':
      return 'mmd';
    case 'image':
      return fileExtension(artifact.url ?? '') || 'png';
    case 'video':
      return fileExtension(artifact.url ?? '') || 'mp4';
    case 'file':
      // 文件产物的扩展名以**磁盘上的路径**为准，这里只是语言映射的兜底
      return (
        fileExtension(artifact.path ?? '') ||
        extensionForLanguage(artifact.language, artifact.content)
      );
    default:
      return extensionForLanguage(artifact.language, artifact.content);
  }
}

/** 文件名里不能出现的字符（Windows 更严：`\ / : * ? " < > |` 与控制字符） */
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]+/g;

/** 标题 → 安全文件名主干：去掉非法字符、尾部点/空格（Windows 会静默丢字符） */
function safeBaseName(title: string, fallback: string): string {
  const cleaned = title
    .replace(UNSAFE_NAME_CHARS, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '');
  return (cleaned || fallback).slice(0, 80);
}

export interface DownloadSpec {
  /** 落盘文件名（含扩展名） */
  fileName: string;
  /** Blob 的 MIME */
  mimeType: string;
}

/**
 * 产物 → 下载用的文件名与 MIME。
 *
 * 文件产物直接用磁盘上的真名（它的身份就是路径，扩展名不该被推断覆盖）；
 * 其余产物用「标题 + 推断扩展名」，且**标题已经带这个扩展名时不重复追加**
 * （`snake.html` 不该变成 `snake.html.html`）。
 */
export function downloadSpecFor(artifact: Artifact): DownloadSpec {
  if (artifact.type === 'file' && artifact.path) {
    const name = fileBaseName(artifact.path);
    const ext = fileExtension(name) || extensionForArtifact(artifact);
    return { fileName: name, mimeType: mimeForExtension(ext) };
  }

  const extension = extensionForArtifact(artifact);
  const base = safeBaseName(artifact.title ?? '', artifact.type);
  const hasExtension = base.toLowerCase().endsWith(`.${extension}`);
  return {
    fileName: hasExtension ? base : `${base}.${extension}`,
    mimeType: mimeForExtension(extension),
  };
}
