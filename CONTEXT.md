# CONTEXT — Struts / JPA 支持给 CodeGraph（遗留 Java 项目重构任务）

> 本文件由 ZCode 于 2026-10-19 创建，用于接续智谱清言（ChatGLM）会话
> https://chatglm.cn/share/rFpTjS0s 的工作。前半部分是该对话的完整脉络摘要，
> 后半部分是落地实现的状态记录。新会话读这一份即可继续。

---

## 一、任务背景（来自清言对话）

**用户场景**：手头有一个约千万行的老 Java 项目（JSP + Struts + JPA 技术栈），
计划按模块拆分重构为微服务（最新 Spring Boot + React）。想用
[CodeGraph](https://github.com/colbymchenry/codegraph) 辅助重构。

**问题**：CodeGraph 的框架感知不支持 Struts（struts.xml 路由在 XML 里，不在
17 个受支持框架之列），JPA 只有 Java 语法层解析（看不到实体关系、Repository
→ 实体、JPQL 查询这些语义）。

**清言给出的结论（对话中逐步验证）**：
1. 可以做，且恰好是 CodeGraph 设计好的扩展路径——Java 语言层已完备，加
   Struts/JPA 属于"框架语义层"工作，不用动 tree-sitter/Rust 内核。
2. 扩展点在 `src/resolution/frameworks/`（框架 resolver 注册表）+
   XML 处理可参考 `src/extraction/mybatis-extractor.ts` 的范式。
3. 建议顺序：JPA 先做（性价比高），Struts 后做（需要处理 XML）。
4. 验证规范（issue #967）：≥2 个真实仓库验证 + 无框架对照组，从最接近的
   现有 resolver 改起。

## 二、清言对话中的关键决策与中间产物

- **架构约定（仓库核心设计）**：抽取阶段只产 `contains` 边和"未解析引用"，
  所有跨文件语义推迟到 resolution 阶段。跨文件桥接（XML→Java）由
  framework resolver 或 synthesizer 完成。
- **MyBatis 范式**：XML 侧建 `<namespace>::<id>` 限定的 method 节点，
  resolution 侧用限定名后缀匹配回 Java `<Class>::<method>`。
- **哨兵后缀模式**（借自 springResolver 的 `:prefix`）：当引用名
  （如 `com.example.LoginAction::doLogin`）不可能作为声明符号存在时，
  加 `:struts` 后缀 + `claimsReference` 放行预过滤器。
- **沙箱预验证**：清言用 Python 沙箱跑过核心正则，抓出三个 bug：
  `<action\b` 误匹配 `<action-mappings>`（`-` 是单词边界）、关系注解漏掉
  带初始化器/夹层注解的字段、JPQL 大小写不敏感误抓别名（`o`、`i`）。
- **对话最后一步**：用户要求"将这个会话窗口中的我和你的对话历史导入到
  CONTEXT.md"，清言的工具调用失败，会话中断——代码当时**尚未**落盘。

## 三、ZCode 接手后的落地实现（2026-10-19 完成）

### 与清言方案的三处有意偏离

| 清言原方案 | 实际落地 | 原因 |
|---|---|---|
| 新建 `src/extraction/struts-extractor.ts` 独立抽取器 + 改 tree-sitter.ts 分发 | 全部放进 `src/resolution/frameworks/struts.ts` 的 `extract()` | 读了真实代码后发现 framework resolver 的 `extract()` 会由 `extractFromSource` 对每个文件调用（Spring 处理 application.yml 就是这条路），无需碰抽取层分发 |
| JPA 引用带 `:jpa-entity` 哨兵 + 自写 resolve() | JPA 引用用**裸类名**，`resolve()` 返回 null | 裸类名是真实符号，走标准 name-matcher 能吃到 import/可见性/同文件优先等既有机制，比自写解析更准 |
| JPA 实体关系用自定义边类型 | 用 `constant` 连接节点 + 标准 `references` 边 | 不改 EDGE_KINDS（那是内核 wire contract，append-only），探索实体时连接节点的入边即关系清单 |

### 新增/修改文件

- **`src/resolution/frameworks/struts.ts`（新增）** — Struts 1 + Struts 2：
  - `extract()`：XML 侧（`struts.xml` / `struts-config.xml` / basename 匹配的
    include 子配置）每个 `<action>` 产一个 `route` 节点（kind='route',
    language='xml'），`<result>`/`<forward>` JSP 路径写进 docstring；
    handler 引用键为 `<FQN>::<method>:struts`。
    不可静态解析的情况（DMI `method="{1}"`、DispatchAction
    `parameter="..."`、无 class 属性）在 docstring 里说明且不发引用。
    Java 侧处理 struts2-convention-plugin 的 `@Action`/`@Namespace`。
  - `resolve()`：按方法名 + `/${Simple}.java` 文件后缀找目标，多候选时用
    FQN 包路径消歧，仍歧义则放弃（silent beats wrong）。
  - `claimsReference(':struts')` 放行名字预过滤器；`detect()` 查
    pom/gradle 的 struts 依赖、struts 配置文件名、web.xml。
  - XML 注释先做长度保持的空白化（照抄 MyBatisExtractor，注释里的
    `<action>` 不产幽灵节点，行号仍准确）。

- **`src/resolution/frameworks/jpa.ts`（新增）** — JPA / Spring Data：
  - 每个实体类产 `jpa:entity:<Class>` 连接节点（kind='constant'），
    docstring 列 `@OneToMany/@ManyToOne/@ManyToMany/@OneToOne` 关系
    （含 mappedBy），每个关系目标发一条裸名 `references` 引用。
  - 每个仓库接口产 `jpa:repository:<I>` 节点，引用泛型管理的实体 +
    `@Query` JPQL 里 `from/join` 的实体（**大小写敏感**，别名词 `o`/`i`
    不会误抓；@Query 按接口体分界归属，一文件多接口不串）。
  - JDK 值类型过滤：`Map<String, Customer>` 取 Customer 不取 String。

- **`src/resolution/frameworks/index.ts`** — 注册 `strutsResolver`、
  `jpaResolver`（Java 段，springResolver 之后）+ 导出。

- **`src/extraction/extraction-version.ts`** — `EXTRACTION_VERSION` 28→29
  （新框架抽取器，老索引需要重建才能拿到新节点/边）。

- **`__tests__/struts.test.ts` + `__tests__/jpa.test.ts`（新增）** — 37 个用例：
  Struts2/Struts1 抽取、注释幽灵节点、DMI/DispatchAction/无 class 跳过、
  `<param name="location">`、convention-plugin、包路径消歧、bean 名不误绑、
  JPA 关系（初始化器+夹层注解）、JPQL 别名不误抓、一文件多接口归属等。

- **`CHANGELOG.md`** — `[Unreleased]` 下新增 `### New Features` 两条
  （Struts 路由、JPA 实体关系，用户视角措辞，无内部路径/符号名）。

- **`docs/design/framework-coverage.md`** — "Server-rendered frameworks"
  小节 14→15 个框架，加 Struts 行（redirect 字面量已在 docstring，缺的是
  JSP 侧节点）；表头验证日期补 Struts 行 2026-10-19。

### 实现中抓出的、清言沙箱没覆盖到的 bug

1. **TDZ 崩溃**（自己的初版）：Struts1 分支在 `dispatchActions` 声明前引用
   它。改为 `ActionInput.dispatch` 字段。
2. **夹层注解正则**：`(?:\s@…)*` 的 `\s` 只吃单个空白，遇到
   `)\n  @JoinColumn`（换行+缩进）必败——清言沙箱的单行样例恰好测不出。
   改 `\s*`（每次迭代至少吃 `@`，无死循环）。
3. **`@Table` 在 `@Entity` 之后**：`@Entity @Table class` 顺序很常见，
   只往前 400 字符搜会漏。改为捕获 @Entity 与 `class` 之间的注解栈一起搜。
4. **Test fixture 自身**：包路径消歧要求文件路径含 `com/example/admin`
   子串，最初 fixture 路径写的是 `admin/com/example/...`。

### 验证结果

- `npx vitest run __tests__/struts.test.ts __tests__/jpa.test.ts` → **37/37**
- 既有框架回归（frameworks / frameworks-integration / framework-* /
  monorepo-app-frameworks / mybatis-extractor-robustness）→ **202/202**
- `npm run build`（tsc + copy-assets + viewer）→ 通过，check-ui-build ok
- **端到端**：`/tmp/struts-fixture`（pom.xml 引 struts2-core + hibernate；
  Struts2 struts.xml 4 action、Struts1 struts-config.xml 2 action、
  4 个实体 + 1 个 Spring Data 仓库）→ `codegraph init` 后直查 SQLite：
  - 6 个 `route` 节点全部就位，docstring 带 result/forward/不可解析说明；
  - 4 条 route→handler `references` 边全部连上
    （welcome→execute、login→doLogin、admin/dashboard→show、
    legacy-login→execute）；DMI 与 DispatchAction 两条正确留空；
  - 5 个 `jpa:entity`/`jpa:repository` 连接节点，关系边
    （Order→OrderItem/Customer/Tag、OrderItem→Order、Customer→Order、
    Repository→Order/Customer）全部解析；
  - `codegraph query "Order relations"` 能搜到 connector 节点。

## 四、已知限制（诚实清单）

- **JSP 仍不是节点**：result/forward 的 JSP 路径只在 route 的 docstring 里，
  `navigates` 边没有绑定目标（见 framework-coverage.md 第 2 节 Struts 行）。
  如果后续要 Screens 图，需要 JSP 占位节点或索引 JSP。
- **Struts2 Spring 插件 bean 名**（`class="loginAction"`）不解析——它不是
  类名，引用留在 unresolved，是诚实结果。
- **通配符**：`/user/*` 路由路径原样保留，`method="{1}"` 不展开。
- **JPQL 拼接**（`"from Order o " + "where…"`）、orm.xml 命名查询不覆盖。
- **JPA 运行时语义**（懒加载、二级缓存、Session 生命周期）静态分析天然
  覆盖不到——安全网仍是测试 + SQL 日志比对。
- **detect() 的 @Entity 兜底全扫**：与 springResolver 的 detect 同成本；
  千万行项目若首次索引变慢，可砍掉兜底只留 pom/gradle 检测。

## 五、下一步建议（按对话里的规划）

1. 在真实老项目的 2–3 个模块上跑 POC（对照 issue #967 的验证规范），
   重点核对：接口+实现类的解析（2026-05 的 issue 提到的缺口）是否覆盖。
2. 若要喂给 AI 会话：`codegraph_explore` 查实体名即可看到关系清单；
   Struts 路由是 `ACTION /path` 节点，`codegraph_explore "LoginAction
   doLogin"` 能走通 URL→Action→Service 链。
3. 微服务拆分边界建议搭配 jdeps + ArchUnit 交叉验证（对话第三节）。
4. 若准备上游 PR：把 `__tests__/struts.test.ts` / `jpa.test.ts` 换成
   真实仓库 fixture 再补对照组数据，CHANGELOG 已备好。

## 六、相关链接

- 清言原对话：https://chatglm.cn/share/rFpTjS0s
- CodeGraph 仓库：https://github.com/colbymchenry/codegraph
- 本地工作副本：`/Users/mac/dev/workspace/codegraph/codegraph-main`
- 设计参考：`docs/design/framework-coverage.md`、
  `src/extraction/mybatis-extractor.ts`（XML 范式）、
  `src/resolution/frameworks/java.ts`（Spring resolver，@Action 模板）
