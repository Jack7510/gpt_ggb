# GGB Script 生成与校对手册

状态：受控子集参考

更新时间：2026-09-09

## 1. 用途与资料来源

本文用于设计 Prompt、审查 LLM codegen 输出和定位 GeoGebra 兼容问题。资料基线包括：

- GeoGebra 官方 Manual 的 Input Bar、Commands、Curves、Conic sections 与 Scripting 页面；
- `ggb-dsh` 当前 contract、静态 validator、compiler 和 applet adapter 的真实 allowlist。

资料源不是可直接执行的 allowlist，也不会整表注入 LLM 上下文。官方手册包含 CAS、统计、UI、文件、
网络和脚本控制等大量命令；本产品只开放经过结构化 schema、静态检查和确定性编码的构图子集。

## 2. 术语

GeoGebra 的输入栏既接受代数表达式，也接受命令。GGBScript 则是按顺序执行的 GeoGebra 输入序列。产品界面
展示的“GeoGebra Script”是已验证 `commands[]` 的可读投影，其中可能同时包含：

```geogebra
A=(0,0)
g=Line(A,B)
c:y^2 = 4x
```

LLM 不直接生成或执行这段自由文本。它只产生 `GgbCodegenPlanV1.operation`；compiler 从受信任对象声明中
生成简短、唯一的实际 GeoGebra 变量名，并负责编码和最终脚本投影。UUID 和摘要只用于事务身份，不进入变量名。

## 3. 方程直接构图

官方手册允许在名称后使用冒号输入圆锥曲线方程：

```geogebra
c:y^2 = 4x
ell:9x^2 + 16y^2 = 144
hyp:9x^2 - 16y^2 = 144
c1:(x - 5)^2 + (y + 2)^2 = 25
```

当前受控 operation 是：

```json
{"kind":"createConicByEquation","output":"<conic objectId>","equation":"y^2 = 4x"}
```

直线方程同样可直接输入，无需为已知方程创建两个辅助点：

```text
d: x = -1
```

```json
{"kind":"createLineByEquation","output":"<line objectId>","equation":"x = -1"}
```

“A 为 d 上一点”必须保留路径依赖，不能降级为恰好落在 d 上的固定坐标：

```text
A=Point(d)
```

```json
{"kind":"createPointOnObject","output":"<point objectId>","object":"<path objectId>"}
```

只有题目明确给定 A 的坐标时才使用 `A=(x,y)`。

高于二次的二维隐式多项式使用：

```json
{"kind":"createImplicitCurveByEquation","output":"<curve objectId>","equation":"x^4 + y^3 = 2xy"}
```

校对规则：

1. `equation` 只含数字、`x`、`y`、空白、括号、等号及 `+ - * / ^ .`。
2. 必须且只能有一个等号，两侧非空，并至少出现 `x` 或 `y`。
3. 最长 256 字符，括号嵌套不超过 16 层，非负整数指数不超过 12。
4. 不得包含输出标签、`:`、`;`、换行语句、字符串、命令名或函数调用。
5. compiler 以 `displayLabel` 为实际变量名；Unicode 下标转换为 ASCII 数字，规范化冲突使用最短 `_2`、
   `_3` 后缀。变量名不得包含 UUID 或摘要片段；执行前若画布已存在同名对象，则拒绝事务而不是覆盖。
6. 二次方程声明 `conic` 并使用 `createConicByEquation`；高于二次的二维隐式多项式声明 `curve` 并使用
   `createImplicitCurveByEquation`。参数曲线和普通函数图像尚未开放对应 contract。

固定方程与定义性构造的选择规则由 plugin-core 的 build 计划和校验拥有；本手册只描述受控子集的语法与校验依据。
参考手册不会整表进入模型上下文；实际模型 SOP 与 build 结果以 plugin-core runner 和交付证据为准。

## 4. 当前受支持命令对照

| 数学目的 | Codegen operation | 编译后的 GeoGebra 形式 |
| --- | --- | --- |
| 坐标点 | `createPointByCoordinates` | `A=(x,y)` 或 `A=(x,y,z)` |
| 对象上的点 | `createPointOnObject` | `A=Point(d)` |
| 两点直线 | `createLineThroughPoints` | `g=Line(A,B)` |
| 方程直线 | `createLineByEquation` | `d:x = -1` |
| 线段 | `createSegment` | `s=Segment(A,B)` |
| 向量 | `createVector` | `v=Vector(A,B)` |
| 交点 | `createIntersection` | `P=Intersect(g,h[,index])` |
| 中点 | `createMidpoint` | `M=Midpoint(A,B)` |
| 垂线 / 平行线 | `createPerpendicularLine` / `createParallelLine` | `g=PerpendicularLine(P,h)` / `g=ParallelLine(P,h)` |
| 角平分线 | `createAngleBisector` | `g=AngleBisector(A,B,C)` |
| 圆 | `createCircleByCenterPoint` / `createCircleByThreePoints` | `c=Circle(O,A)` / `c=Circle(A,B,C)` |
| 多边形 | `createPolygon` | `p=Polygon(A,B,C,...)` |
| 五点圆锥曲线 | `createConicByFivePoints` | `c=Conic(A,B,C,D,E)` |
| 方程圆锥曲线 | `createConicByEquation` | `c:y^2 = 4x` |
| 隐式多项式曲线 | `createImplicitCurveByEquation` | `c:x^4 + y^3 = 2xy` |
| 抛物线 | `createParabola` | `c=Parabola(F,d)` |
| 椭圆 / 双曲线 | `createEllipse` / `createHyperbola` | `c=Ellipse(F1,F2,A)` / `c=Hyperbola(F1,F2,A)` |
| 三点平面 | `createPlaneThroughPoints` | `p=Plane(A,B,C)` |
| 两平面交线 | `createPlaneIntersection` | `g=Intersect(p,q)` |
| 平行 / 垂直平面 | `createParallelPlane` / `createPerpendicularPlane` | `p=Plane(A,q)` / `p=PerpendicularPlane(A,g)` |
| 球 | `createSphereByCenterPoint` / `createSphereByCenterRadius` | `s=Sphere(O,A)` / `s=Sphere(O,r)` |
| 棱柱 / 棱锥 | `createPrism` / `createPyramid` | `p=Prism(base,A)` / `p=Pyramid(base,A)` |
| 圆锥 / 圆柱 | `createCone` / `createCylinder` | `q=Cone(A,B,r)` / `q=Cylinder(A,B,r)` |
| 正方体 | `createCube` | `q=Cube(A,B[,C])` |

标签、可见性、颜色、线宽、点大小和填充由 `setLabel`、`setVisibility`、`setStyle` 转成受控展示命令。

## 5. Codegen 校对清单

对每次 LLM 输出依次检查：

1. `planId` 与全部 `stepId` 是否逐一匹配受信任 math plan。
2. 每个非 protected 对象是否恰好生产一次，输出类型是否匹配声明。
3. operation 字段是否严格符合 Prompt 和 contract，是否引用已声明且位于依赖闭包中的对象。
4. 题目已给方程时是否避免了没有数学必要的辅助点、焦点或准线；题目要求动态定义时是否保留依赖构造。
5. 方程是否通过第 3 节的受限语法检查；不得把可读脚本当作 operation 字符串传入。
6. 编译后每条 command 是否通过 schema 和 encoder，输出标签是否由 compiler 生成。
7. applet 是否真实创建对象，观察类型和属性是否可读取，必需 assertions 是否全部通过。
8. 只有 `executionStatus: applied` 且 `validationStatus: passed` 才能向用户声称完成。

## 6. CSV 中已核对但尚未开放的能力

原始 CSV 还包含 `PerpendicularBisector`、`Ray`、`Semicircle`、参数 `Curve`、`ImplicitCurve` 命令、`Tangent`、
`LocusEquation`、正多面体、统计和 CAS 等命令。新增能力时必须先建立 operation schema、输入类型规则、
compiler 映射、观察兼容和语义验证，再加入 Prompt；不得只把命令名称加入 Prompt 或放开任意字符串执行。
