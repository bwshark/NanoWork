import type { ReactNode } from "react";
import CodeIcon from "@mui/icons-material/Code";
import CoffeeIcon from "@mui/icons-material/Coffee";
import PaletteIcon from "@mui/icons-material/Palette";
import ArticleIcon from "@mui/icons-material/Article";
import AccountBalanceWalletIcon from "@mui/icons-material/AccountBalanceWallet";
import PieChartIcon from "@mui/icons-material/PieChart";
import GridViewIcon from "@mui/icons-material/GridView";
import SlideshowIcon from "@mui/icons-material/Slideshow";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import OndemandVideoIcon from "@mui/icons-material/OndemandVideo";
import AssignmentIcon from "@mui/icons-material/Assignment";
import WebIcon from "@mui/icons-material/Web";
import WebAssetIcon from "@mui/icons-material/WebAsset";
import SmartToyIcon from "@mui/icons-material/SmartToy";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import ImageIcon from "@mui/icons-material/Image";
import PhoneIphoneIcon from "@mui/icons-material/PhoneIphone";
import StyleIcon from "@mui/icons-material/Style";

/** 三种模式 id(顶部 segmented 按钮) */
export type HeroModeId = "office" | "code" | "design";

/** 提示词标签:点击后把 prompt 填入输入框 */
export interface HeroPromptTag {
  label: string;
  prompt: string;
}

/** Skill 技能:模式下的一级胶囊,点击后在输入框插入徽章并展示其提示词标签 */
export interface HeroSkill {
  id: string;
  label: string;
  icon: ReactNode;
  tags: HeroPromptTag[];
}

export interface HeroMode {
  id: HeroModeId;
  label: string;
  icon: ReactNode;
  skills: HeroSkill[];
}

/**
 * 空状态三级联动数据:模式 → Skill 技能 → 提示词标签 → 提示词。
 * 内容来源:docs/img/chat/4-6.png 脑图;脑图未覆盖的 Skill 补充了常用提示词标签。
 */
export const HERO_MODES: HeroMode[] = [
  {
    id: "office",
    label: "日常办公",
    icon: <CoffeeIcon fontSize="small" />,
    skills: [
      {
        id: "office-doc",
        label: "文档处理",
        icon: <ArticleIcon fontSize="small" />,
        tags: [
          {
            label: "财务分析全流程",
            prompt:
              "帮我下载腾讯2025中期报告完整财报 PDF，从 PDF 中提取财务数据，创建一个 Excel 财务模型（包含公式和格式），然后制作一份演示文稿（使用 Ocean Gradient 配色），最后生成一份包含完整分析的 Word 报告（带目录和页眉页脚）",
          },
          {
            label: "MD转PDF文档",
            prompt:
              "帮我把【上传的 Markdown 文件】转换成排版精美的 PDF 文档，要求：自定义封面页（标题 + 作者 + 日期）、自动生成目录、代码块带语法高亮、表格有交替行底色、页脚显示页码。",
          },
          {
            label: "竞品对比分析",
            prompt:
              "帮我从这 3 份竞品分析 PDF 中提取核心信息，整理成一份 Excel 竞品对比矩阵（功能维度 × 竞品），并生成一份 Word 竞品分析报告，包含：市场定位对比、功能差异分析、优劣势总结、建议行动项。",
          },
          {
            label: "项目周报转Word",
            prompt:
              "帮我基于【上传的项目周报 Excel】，自动生成一份 Word 格式的项目状态报告，包含：项目概况仪表板（进度百分比、风险等级、里程碑状态）、本周完成事项、下周计划、风险与阻塞项、资源需求，使用专业的项目报告模板排版。",
          },
        ],
      },
      {
        id: "office-finance",
        label: "金融服务",
        icon: <AccountBalanceWalletIcon fontSize="small" />,
        tags: [
          {
            label: "可比公司分析",
            prompt:
              "帮我做一个 Snowflake (SNOW) 的可比公司分析，重点关注云数据平台赛道的同业公司，包含 EV/Revenue、EV/GP、Rule of 40 等关键指标。",
          },
          {
            label: "DCF估值模型",
            prompt:
              "构建一个完整的 DCF 模型，考虑 AI 芯片需求的 Bear/Base/Bull 三种情景，Base case 假设未来 5 年营收 CAGR 25%，输出包含 WACC 敏感性分析和终值敏感性分析的 Excel。",
          },
          {
            label: "Meta财务分析",
            prompt:
              "金融服务 分析 Meta (META) 最新一季度财报，重点关注：广告收入 vs 街头预期、Reality Labs 亏损趋势、AI 投资回报 (Capex guidance)、用户增长和 engagement 数据，输出一份 8-10 页的 Earnings Update Report，含图表。",
          },
          {
            label: "并购出售材料",
            prompt:
              '我们正在准备出售 "DataFlow Analytics"（企业数据平台，ARR $200M），请按以下步骤帮我准备全套材料：1. 先做一个可比公司对标分析确定估值区间 2. 用 DCF 和 LBO 验证估值 3. 准备匿名 one-pager teaser 4. 撰写完整的 CIM 5. 整理潜在买家名单',
          },
          {
            label: "个人理财规划",
            prompt:
              '为客户 "张先生" 制定综合理财规划：45 岁，已婚，2 个孩子（10 岁、14 岁），家庭年收入 $800K，流动资产 $5M，目标：55 岁提前退休、两个孩子的大学教育基金、遗产规划，风险偏好：中等偏保守。请覆盖退休规划、教育规划、税务优化和遗产安排',
          },
        ],
      },
      {
        id: "office-data",
        label: "数据分析及可视化",
        icon: <PieChartIcon fontSize="small" />,
        tags: [
          {
            label: "销售周报看板",
            prompt:
              "帮我基于【上传的销售数据 Excel】生成一份周报看板：包含销售额趋势、区域对比、TOP10 产品排行，输出带交互图表的 HTML 看板。",
          },
          {
            label: "问卷数据分析",
            prompt:
              "帮我分析这份调研问卷数据（【上传的 CSV】）：做数据清洗、描述性统计、交叉分析，输出结论摘要与可视化图表。",
          },
          {
            label: "数据清洗脚本",
            prompt:
              "帮我写一个 Python 脚本，清洗【上传的数据文件】：去重、缺失值处理、格式统一，并输出一份清洗报告。",
          },
          {
            label: "图表美化建议",
            prompt:
              "帮我把这组图表（【描述或上传图表】）按专业报告风格美化：配色、字体、图例、数据标注，给出可直接使用的配置与修改建议。",
          },
        ],
      },
      {
        id: "office-workbench",
        label: "个人工作台",
        icon: <GridViewIcon fontSize="small" />,
        tags: [
          {
            label: "每日待办规划",
            prompt:
              "帮我规划今天的工作安排：我有这些事项【事项列表】，请按重要紧急程度排序，给出时间块安排建议。",
          },
          {
            label: "会议纪要整理",
            prompt:
              "帮我把这段会议记录整理成结构化纪要：议题、结论、待办（负责人 + 截止时间）、风险点。",
          },
          {
            label: "周报自动生成",
            prompt:
              "帮我基于本周完成事项【列表】生成一份周报：本周进展、关键成果、下周计划、需要协调的事项。",
          },
        ],
      },
      {
        id: "office-slides",
        label: "幻灯片",
        icon: <SlideshowIcon fontSize="small" />,
        tags: [
          {
            label: "商业计划PPT",
            prompt:
              "帮我制作一份商业计划 PPT（10 页）：市场机会、产品方案、商业模式、竞争分析、团队、财务预测、融资计划，风格专业简洁。",
          },
          {
            label: "产品发布PPT",
            prompt:
              "帮我做一份产品发布会 PPT：开场钩子、痛点、产品亮点演示、用户案例、价格与购买方式，整体科技感。",
          },
          {
            label: "培训课件PPT",
            prompt:
              "帮我把这份培训材料【上传文档】转换成课件 PPT：学习目标、分章节讲解、案例、随堂练习、总结。",
          },
        ],
      },
      {
        id: "office-research",
        label: "深度研究",
        icon: <TravelExploreIcon fontSize="small" />,
        tags: [
          {
            label: "行业趋势研究",
            prompt:
              "帮我研究【行业名称】未来 3 年的发展趋势：市场规模、驱动因素、竞争格局、风险，附信息来源。",
          },
          {
            label: "技术选型对比",
            prompt:
              "帮我对比【技术A】与【技术B】：性能、生态、学习成本、维护成本、适用场景，给出选型建议。",
          },
          {
            label: "政策影响解读",
            prompt:
              "帮我解读【政策名称】对【行业/公司】的影响：核心条款、短期与长期影响、应对建议。",
          },
        ],
      },
      {
        id: "office-video",
        label: "视频生成",
        icon: <OndemandVideoIcon fontSize="small" />,
        tags: [
          {
            label: "产品宣传视频",
            prompt:
              "帮我生成一段 15 秒产品宣传视频脚本 + 分镜：【产品名称与卖点】，节奏明快，结尾带 slogan。",
          },
          {
            label: "短视频口播稿",
            prompt:
              "帮我写一条 60 秒短视频口播稿：主题【主题】，开头 3 秒钩子，中间 3 个要点，结尾引导关注。",
          },
          {
            label: "解说视频分镜",
            prompt:
              "帮我把这篇文章【上传/粘贴】拆成解说视频分镜表：画面描述、旁白、时长、转场方式。",
          },
        ],
      },
      {
        id: "office-pm",
        label: "产品管理",
        icon: <AssignmentIcon fontSize="small" />,
        tags: [
          {
            label: "PRD撰写",
            prompt:
              "帮我撰写一份 PRD：功能【功能描述】，包含背景、目标、用户故事、功能清单、流程描述、验收标准、排期建议。",
          },
          {
            label: "用户故事拆解",
            prompt:
              "帮我把这个需求【需求描述】拆解成用户故事和任务卡：按 INVEST 原则，附验收标准与优先级。",
          },
          {
            label: "需求优先级排序",
            prompt:
              "帮我用 RICE 模型对这批需求【需求列表】排序，输出优先级矩阵与迭代建议。",
          },
          {
            label: "上线复盘报告",
            prompt:
              "帮我写一份功能上线复盘报告：目标达成、数据表现、问题与根因、后续改进项。",
          },
        ],
      },
    ],
  },
  {
    id: "code",
    label: "代码开发",
    icon: <CodeIcon fontSize="small" />,
    skills: [
      {
        id: "code-daily",
        label: "日常开发",
        icon: <CodeIcon fontSize="small" />,
        tags: [
          {
            label: "新增功能开发",
            prompt: "帮我给当前项目添加一个新功能：【功能描述】。",
          },
          {
            label: "代码重构优化",
            prompt: "帮我重构这段代码，提升可读性和可维护性。",
          },
          {
            label: "修复Bug",
            prompt: "帮我修复这个 Bug：【Bug 描述】。",
          },
          {
            label: "性能优化",
            prompt: "帮我优化这个功能的性能，当前问题是【性能问题描述】。",
          },
        ],
      },
      {
        id: "code-web",
        label: "网站开发",
        icon: <WebIcon fontSize="small" />,
        tags: [
          {
            label: "企业官网开发",
            prompt:
              "网站开发 帮我开发一个企业官网，公司名称是【公司名称】，主营业务是【业务描述】。要求：包含首页、关于我们、产品服务、联系我们页面，风格简约大气。",
          },
          {
            label: "后台管理系统",
            prompt:
              "帮我开发一个后台管理系统，用于管理【管理内容】。要求：包含登录页、数据看板、列表管理、表单编辑功能，支持响应式布局。",
          },
          {
            label: "个人博客网站",
            prompt:
              "帮我开发一个个人博客网站，博客主题是【博客主题】。要求：包含文章列表、文章详情、标签分类、关于页面，支持 Markdown 渲染。",
          },
          {
            label: "电商首页开发",
            prompt:
              "帮我开发一个电商网站首页，售卖【商品类型】。要求：包含轮播图、商品分类、热门商品展示、促销活动区域。",
          },
        ],
      },
      {
        id: "code-agent",
        label: "Agent 应用",
        icon: <SmartToyIcon fontSize="small" />,
        tags: [
          {
            label: "工作流设计",
            prompt:
              "帮我设计一个 Agent 工作流：目标【目标描述】，拆成工具调用、分支判断、人工确认节点，输出流程说明。",
          },
          {
            label: "工具函数编写",
            prompt:
              "帮我为 Agent 编写一个工具函数：能力【能力描述】，包含入参校验、错误处理与使用说明。",
          },
          {
            label: "提示词优化",
            prompt:
              "帮我优化这段 Agent 系统提示词【粘贴】：目标更聚焦、输出格式更稳定、边界条件更明确。",
          },
        ],
      },
      {
        id: "code-skill",
        label: "Skill 开发",
        icon: <AutoAwesomeIcon fontSize="small" />,
        tags: [
          {
            label: "技能文件编写",
            prompt:
              "帮我编写一个 SKILL.md 技能文件：技能用途【描述】，包含触发条件、步骤、注意事项、验证方式。",
          },
          {
            label: "技能模板生成",
            prompt:
              "帮我基于【场景描述】生成一个可复用技能模板：输入、输出、标准流程、质量检查清单。",
          },
          {
            label: "技能评审优化",
            prompt:
              "帮我评审这份技能定义【粘贴】：找出歧义与遗漏，给出改进版。",
          },
        ],
      },
      {
        id: "code-cicd",
        label: "CI/CD",
        icon: <AccountTreeIcon fontSize="small" />,
        tags: [
          {
            label: "流水线设计",
            prompt:
              "帮我设计一套 CI/CD 流水线：技术栈【栈描述】，包含构建、测试、制品、部署、回滚策略。",
          },
          {
            label: "自动化测试集成",
            prompt:
              "帮我把自动化测试接入流水线：单测 + lint + 构建产物检查，失败时通知与重试策略。",
          },
          {
            label: "发布脚本编写",
            prompt:
              "帮我写一个发布脚本：打 tag、生成 changelog、构建、上传制品、通知群消息。",
          },
        ],
      },
      {
        id: "code-doc",
        label: "文档",
        icon: <ArticleIcon fontSize="small" />,
        tags: [
          {
            label: "API文档生成",
            prompt:
              "帮我根据这份代码【上传/粘贴】生成 API 文档：接口说明、参数、返回值、示例、错误码。",
          },
          {
            label: "README编写",
            prompt:
              "帮我为这个项目写一份 README：简介、特性、快速开始、配置说明、常见问题。",
          },
          {
            label: "变更日志整理",
            prompt:
              "帮我基于这些提交记录【粘贴 git log】整理一份用户可读的 CHANGELOG。",
          },
        ],
      },
    ],
  },
  {
    id: "design",
    label: "设计创意",
    icon: <PaletteIcon fontSize="small" />,
    skills: [
      {
        id: "design-ppt",
        label: "PPT设计",
        icon: <SlideshowIcon fontSize="small" />,
        tags: [
          {
            label: "像素风介绍PPT",
            prompt:
              "制作一个我的世界介绍6页ppt,要有炫酷丰富的像素风格的排版，像素主题设计风格",
          },
          {
            label: "论文答辩PPT",
            prompt:
              "制作一份硕士论文答辩 PPT，共 10 页，风格严谨学术。主色调采用深藏青（#0F172A）作为标题色，正文炭灰（#334155），关键发现用学术红（#B91C1C）标注，背景保持纯白。页面结构为：封面、研究背景与意义、文献综述、研究问题与假设、研究方法、实验设计、数据分析、主要结论、研究局限与展望、致谢。图表使用经典黑白灰配色，不使用渐变。每页右上角标注章节编号便于答辩委员快速定位。字体中文使用宋体，英文使用 Times New Roman。页脚放置学校 Logo、姓名、学号、日期。整体克制专业，突出研究的学术价值",
          },
          {
            label: "人形机器人调研",
            prompt:
              "创建10页关于「人形机器人2026」的内部调研PPT演示文稿。要求包括，进行联网搜索获取人形机器人领域的最新趋势和发展动态，重点涵盖具身智能技术的最新进展和突破，分析人形机器人从实验室研发阶段到工厂实际应用的转化情况，整合丰富且可靠的数据可视化图表，包括市场预测、技术对比、应用场景等。形成一份完整的、适合内部汇报使用的调研材料。钛金灰 Titanium 视觉风格，#1C1C1E 钛黑 + #A1A1AA 银灰 + #F59E0B 暖金点睛，整体工业、精密、严谨。",
          },
          {
            label: "武侠游戏发布会",
            prompt:
              '帮我生成一组中式武侠开放世界探索游戏的发布会幻灯片设计稿，包含6个主要页面，排版布局要大，方便现场大屏播放，大胆的使用SVG装饰幻灯片，页面元素要丰富精致，展示游戏的美术设计，UI设计，内容丰富等等要素, 需要生成图片的地方采用"ai"模式',
          },
        ],
      },
      {
        id: "design-poster",
        label: "视觉海报",
        icon: <ImageIcon fontSize="small" />,
        tags: [
          {
            label: "咖啡馆宣传海报",
            prompt: "生成三张咖啡馆宣传海报",
          },
          {
            label: "NEXA芯片发布会",
            prompt:
              "NEXA 推理芯片发布会 场景：AI 芯片公司 NEXA 宣布首款自研推理芯片 Silicon-1 流片成功，全球发布会。主标：NEXA Silicon-1 全球发布会 副标：2nm 制程 · 3 年研发 · 第一次流片成功 信息层：2026 年 7 月 9 日 · 上海 · 同步全球直播 AI 生图 Prompt：一块裸芯片晶粒悬浮在绝对的黑暗中，被一束极窄的冷白光从正上方劈下，芯片表面的纳米级金属走线在光照下泛起彩虹色的衍射光晕——从铜金色过渡到靛蓝再到电紫。极端微距摄影，景深极浅，焦点精准落在芯片正中央的运算核心区，边缘的焊盘阵列虚化成模糊的几何纹理。真实棚拍布光，无合成感，无噪点，工业级质感，像《科学》杂志封面。字体建议：Inter Black 标题；中文思源黑体 Medium；",
          },
          {
            label: "STRIDE运动海报",
            prompt:
              "16:9全出血动作海报，品牌STRIDE，主标OWN THE PACE。海岸公路跑步者低角度广角冲刺，正午强光，荧光黄绿跑鞋为唯一强调色，环境天蓝。巨型暖奶油块状字置于主体后方，白色编辑微文案与大号032锚定网格。4色2字体，高对比商业摄影写实，所有文字进安全区不重叠不出血。",
          },
          {
            label: "动漫杂志封面",
            prompt:
              "竖版 9:16 封面，油画质感动漫写实风，深靛蓝底+暗金点缀（#080814 / #C9A84C）。主标题用 Yuji Syuku 行书毛笔体大字号层顶（白色+5层蓝紫霓虹光晕），副标题用 Shippori Mincho B1 明朝体配金色装饰线夹住；顶部装饰带带英文系列标识，中部留插画主体，底部暗化渐变上叠「引言—三栏信息行（角色/卷号/状态）—细信息条（价格/ISBN/日期）」四层排版，右侧加竖排旋转英文装饰。全文行书+明朝双字体混排，金色低饱和度统一点缀，暗色投影分层增强立体感。",
          },
        ],
      },
      {
        id: "design-web",
        label: "网站设计",
        icon: <WebIcon fontSize="small" />,
        tags: [
          {
            label: "落地页设计",
            prompt:
              "帮我设计一个产品落地页：【产品描述】，包含首屏主张、特性展示、社会证明、定价、CTA，风格现代简洁。",
          },
          {
            label: "深色主题官网",
            prompt:
              "帮我设计一套深色主题官网视觉：主色、辅助色、字体层级、卡片与按钮规范，输出设计说明。",
          },
          {
            label: "交互原型说明",
            prompt:
              "帮我输出这份页面【描述】的交互说明：布局、状态、动效、响应式断点行为。",
          },
        ],
      },
      {
        id: "design-app",
        label: "移动端App",
        icon: <PhoneIphoneIcon fontSize="small" />,
        tags: [
          {
            label: "首页界面设计",
            prompt:
              "帮我设计一个【类型】App 首页：信息流 + 快捷入口 + 底部导航，输出界面描述与配色方案。",
          },
          {
            label: "引导页设计",
            prompt:
              "帮我设计 3 屏新手引导页：价值主张插画描述 + 文案，风格轻松。",
          },
          {
            label: "个人中心设计",
            prompt:
              "帮我设计 App 个人中心页：头像、数据卡片、功能列表、设置入口，适配深色模式。",
          },
        ],
      },
      {
        id: "design-system",
        label: "设计系统",
        icon: <PaletteIcon fontSize="small" />,
        tags: [
          {
            label: "色彩体系搭建",
            prompt:
              "帮我搭建一套品牌色彩体系：主色、中性色、语义色、暗色模式映射，给出 HEX 与使用规则。",
          },
          {
            label: "组件规范文档",
            prompt:
              "帮我写一份组件规范：按钮、输入、卡片、弹窗的状态与尺寸规则，附使用示例。",
          },
          {
            label: "图标风格定义",
            prompt:
              "帮我定义一套图标风格：线宽、圆角、网格、隐喻原则，输出 10 个示例图标描述。",
          },
        ],
      },
      {
        id: "design-webapp",
        label: "Web App",
        icon: <WebAssetIcon fontSize="small" />,
        tags: [
          {
            label: "仪表盘设计",
            prompt:
              "帮我设计一个数据仪表盘 Web App：指标卡 + 趋势图 + 明细表，支持暗色模式。",
          },
          {
            label: "看板工具设计",
            prompt:
              "帮我设计一个任务看板 Web App：列布局、卡片信息、拖拽交互、筛选器。",
          },
        ],
      },
      {
        id: "design-brand",
        label: "品牌设计",
        icon: <StyleIcon fontSize="small" />,
        tags: [
          {
            label: "品牌VI方案",
            prompt:
              "帮我设计一套品牌 VI：【品牌名与定位】，标志概念、标准字、标准色、应用示例（名片/包装/头像）。",
          },
          {
            label: "Logo创意发散",
            prompt:
              "帮我围绕【品牌关键词】发散 6 个 Logo 创意：图形概念 + 字体风格 + 配色，各附一句说明。",
          },
          {
            label: "品牌口号撰写",
            prompt:
              "帮我为【品牌/产品】撰写 10 条 slogan：简洁、有记忆点、符合【调性】。",
          },
        ],
      },
    ],
  },
];
