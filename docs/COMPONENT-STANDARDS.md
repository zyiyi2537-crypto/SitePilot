# SitePilot 首版建站与组件规范

## 客户交互闭环

1. 客户描述建站目标后，Architect 形成需求摘要、目标用户、转化目标、页面清单和初始内容结构。
2. Agent 只追问会改变方案或内容正确性的缺失信息：品牌/产品事实、目标客户、主要行动、联系方式、语言、已有品牌素材、必需页面与法律/行业限制。非阻塞项可先按明确标注的假设继续。
3. 先生成可审阅的设计稿包：站点地图、关键页面线框、区块顺序、组件候选、视觉方向和未确认假设。客户确认方向后才进入代码实现。
4. Research 从 CodeAtlas 按框架、组件类型和冻结提交检索；结果必须绑定 repository、commit、path、license 和兼容信息。
5. 先选已批准 Registry 组件；没有适配项时再查固定版本的开源实现。来源、许可证、依赖、键盘/移动端行为和测试通过复核后，才可写入项目。
6. Coding 在隔离 worktree 实现；Build、浏览器 QA 和事实/内容 QA 绑定同一候选 hash。通过后交人工 Review，不自动发布。

## 当前 Payload 基线

Payload Website Template 固定在 `sources/payload-website.lock.json` 中的提交，许可证为 MIT。模板可直接复用的站点结构包括 Payload Header Global、Footer Global、页面 Layout Builder、基础内容区块、草稿预览和 SEO。

导航相关源文件：

- `templates/website/src/Header/config.ts`
- `templates/website/src/Header/Component.tsx`
- `templates/website/src/Header/Component.client.tsx`
- `templates/website/src/Header/Nav/index.tsx`

模板当前 `Header` 通过 Payload Global 的 `navItems` 管理，最多 6 个顶层 link，由 `HeaderNav` 渲染。它没有嵌套 submenu 或多列 mega-menu 数据模型；不能把它描述成已经支持多级导航。已有实现应作为 Header/CMS 数据绑定起点，新增需求需要扩展 schema、前端和测试。

CodeAtlas 当前索引的 `startup-nextjs` 可检索到 `src/components/Header/index.tsx`、`src/components/Header/menuData.tsx` 和 `src/types/menu.ts`，其中 `Menu.submenu` 是普通嵌套子菜单。当前证据提交为 `e730b6a99c77b96c835f11347231faa4f4e9f767`。该实现只作为检索候选：许可证和无障碍质量未完成 SitePilot Registry 审核，不应直接作为规范或复制依据。MCP 已有读取/检索工具，但没有索引写入工具；不要声称已经把 Payload 加入 CodeAtlas。

## Header / Dropdown 契约

- 使用站点级 `<header>` 与带可读名称的 `<nav>`；导航项由结构化 CMS 数据驱动，不将客户内容硬编码进组件。
- 普通链接保持真正的链接语义；展开控件使用 `<button>`，包含 `aria-expanded`、`aria-controls` 和稳定的关联 ID。不可用可点击 `<p>` 代替按钮。
- 菜单支持键盘 Tab/Shift+Tab、Enter/Space、Escape 关闭；焦点可见。普通网站导航优先使用 disclosure navigation，不随意套用应用菜单的 `role="menu"` 键盘模型。
- 移动端使用按钮切换导航，状态通过 `aria-expanded` 暴露；切换路由后收起，点击外部关闭。事件监听在 effect cleanup 中移除。
- active link 依据当前 pathname/locale 正确标记；外部链接新开窗口时显式声明行为。链接目标须来自客户事实、页面计划或已审阅的 CMS 数据。
- Nested dropdown 默认最多两层。超过两层、条目过多或需要按产品/行业分组时，使用 mega-menu 分栏，不将长列表压入单列浮层。
- Mega-menu CMS 数据采用显式 `groups[]`，每组包含标题与 `items[]`；每项含 label、内部页面引用或经过校验的 URL，可选短描述。营销图片/推荐卡片必须有证据与 alt 文本，不能由 Agent 虚构。
- Mega-menu 桌面端由顶层按钮控制，可键盘到达并可 Esc 关闭；移动端降级为分组 accordion。断点变化时状态可预测，内容不溢出视口。
- 不通过 CSS hover 作为唯一打开方式，不以颜色作为唯一状态提示；触屏、缩放和 reduced-motion 均需可用。

## Registry 晋级门禁

每个可复用组件记录 source repository、完整 commit、文件路径、许可证证据、目标框架/版本、props/CMS schema、依赖、responsive 与 keyboard 行为、测试结果和 reviewer。缺来源或许可证时保持 `candidate` / `reference-only`，不能进入 Agent 的自动代码复用选择。

最小导航测试：

- 桌面/移动视口下主导航和展开面板可见、无重叠或横向溢出。
- 键盘可打开、遍历、关闭 dropdown；焦点不会丢失。
- `aria-expanded` 与真实面板状态一致；按钮和链接可被辅助技术识别。
- 页面、locale 切换后 active 状态正确，导航目标均有效。
- Payload Global 数据缺失、空数组、长标题和长菜单项不会导致运行时错误或布局破坏。

## CodeAtlas 缺项策略

CodeAtlas 是代码证据检索层，不是未经审核的组件批准层。查询无可靠结果时，Research Agent 可搜索官方模板/仓库；必须先固定 commit 并验证目录范围和许可证，再检查依赖与交互行为。成功集成并测试的自有适配层可登记 Registry；向 CodeAtlas 新增来源目前需要其管理员 GitHub 来源流程，MCP token 本身不能写索引。不得通过数据库直写绕过该流程。
