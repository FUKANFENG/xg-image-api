export const INSPIRATION_DRAFT_STORAGE_KEY = "xg-inspiration-draft";

export type InspirationCategory =
  | "all"
  | "character"
  | "ui"
  | "poster"
  | "portrait"
  | "marketing"
  | "product"
  | "curated";

export type InspirationDraft = {
  title: string;
  prompt: string;
  size: string;
  quality: string;
  reference_url?: string;
  asset_id?: string;
  parent_version_id?: string;
};

export type InspirationPreviewCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const INSPIRATION_PREVIEW_ATLAS_SOURCE = {
  width: 1_254,
  height: 1_254,
} as const;

export type InspirationTemplate = InspirationDraft & {
  id: string;
  category: Exclude<InspirationCategory, "all">;
  categoryLabel: string;
  level: "入门" | "进阶" | "创意";
  preview: string;
  previewCrop?: InspirationPreviewCrop;
  description: string;
  tags: string[];
};

export const inspirationCategories: Array<{
  id: InspirationCategory;
  label: string;
}> = [
  { id: "all", label: "全部" },
  { id: "character", label: "角色设计" },
  { id: "ui", label: "UI 界面" },
  { id: "poster", label: "海报视觉" },
  { id: "portrait", label: "人像摄影" },
  { id: "marketing", label: "品牌营销" },
  { id: "product", label: "产品摄影" },
  { id: "curated", label: "用户精选" },
];

export const inspirationTemplates: InspirationTemplate[] = [
  {
    id: "sky-courier-character-sheet",
    category: "character",
    categoryLabel: "角色设计",
    level: "进阶",
    title: "云海信使角色设定稿",
    description: "用完整视角、装备拆解和色彩规则，快速建立有辨识度的原创角色。",
    preview: "/inspiration/character-sheet.png",
    tags: ["角色三视图", "设定稿", "概念设计"],
    size: "1536x1024",
    quality: "high",
    prompt:
      "为一名穿行在云海之间的年轻信使设计原创角色设定稿。画面包含正面、侧面和背面全身视图；深蓝短外套搭配黄铜扣件、轻型护目镜、旧皮革邮袋和耐磨长靴。右侧补充手套、邮袋、徽章和靴子的小型装备拆解，底部给出 5 个低饱和蓝灰与暖金色样本。米白色纸张背景、细薄版式辅助线、半写实概念艺术、柔和工作室光线、清晰材质细节。不要文字、不要水印、不要任何现有 IP 元素。",
  },
  {
    id: "violet-analytics-dashboard",
    category: "ui",
    categoryLabel: "UI 界面",
    level: "进阶",
    title: "紫调数据工作台",
    description: "适合产品概念、SaaS 宣传图和仪表盘视觉方向的快速探索。",
    preview: "/inspiration/ui-dashboard.png",
    tags: ["SaaS", "数据面板", "界面概念"],
    size: "1536x1024",
    quality: "high",
    prompt:
      "设计一张原创桌面端 AI 数据工作台界面概念图，置于深色笔记本电脑屏幕中。界面采用深石墨底色，卡片使用紫罗兰与珊瑚色强调，包含趋势线、柱状图、环形图、指标卡和简洁侧边栏。所有信息使用抽象几何符号与不可读占位块，不要真实品牌、不要可读文字。产品设计展示图风格，三分之二视角，柔和紫粉色棚拍光，精致、干净、现代。",
  },
  {
    id: "rainy-future-city-poster",
    category: "poster",
    categoryLabel: "海报视觉",
    level: "创意",
    title: "雨夜未来城主视觉",
    description: "用单一叙事主体和强透视关系，建立电影感的海报画面。",
    preview: "/inspiration/future-poster.png",
    tags: ["科幻", "电影感", "城市夜景"],
    size: "1024x1536",
    quality: "high",
    prompt:
      "创作一张竖版原创科幻电影主视觉：雨后的高架步道从前景延伸到远处，一名穿深色风衣的人背对镜头，面向临海未来城市。建筑群被靛蓝和青色灯光照亮，空气中有薄雾，湿润地面反射零星暖光。构图强调前景引导线与远处天际线，留出上方干净留白作为后期标题区域。电影级光影、克制写实、细节丰富。不要文字、不要 logo、不要模仿已有电影海报。",
  },
  {
    id: "morning-editorial-portrait",
    category: "portrait",
    categoryLabel: "人像摄影",
    level: "入门",
    title: "晨光编辑人像",
    description: "通过镜头、布光、材质和情绪描述，让人像更有真实的杂志质感。",
    preview: "/inspiration/editorial-portrait.png",
    tags: ["35mm", "编辑人像", "自然光"],
    size: "1024x1536",
    quality: "medium",
    prompt:
      "拍摄一张原创编辑人像：一位成年东亚女性穿象牙白西装坐在极简混凝土窗边，清晨侧光穿过窗框，在墙面形成柔和阴影。使用 35mm 胶片风格，轻微颗粒，肤质自然，面料纹理清晰，表情平静自信。竖版近中景构图，背景克制、低饱和暖灰色。不要文字、不要品牌、不要水印、不要使用任何真实人物肖像。",
  },
  {
    id: "coral-beauty-campaign",
    category: "marketing",
    categoryLabel: "品牌营销",
    level: "创意",
    title: "珊瑚色新品主视觉",
    description:
      "把产品、色彩、留白和使用场景写清楚，生成更可用于营销的主视觉。",
    preview: "/inspiration/marketing-coral.png",
    tags: ["营销视觉", "美妆", "色彩构成"],
    size: "1536x1024",
    quality: "high",
    prompt:
      "创作一张原创护肤新品营销主视觉：无品牌的半透明珊瑚色玻璃瓶放在淡紫色圆台上，周围有放大的柔粉色花瓣、弧形色块和清晰植物投影。画面采用明亮的艺术指导摄影，珊瑚红、奶油白和淡紫色为主，瓶身保持完全无文字，右上方留出干净留白用于后期文案。高级、轻盈、现代、细节清晰。不要 logo、不要水印、不要复制现有广告。",
  },
  {
    id: "spring-tea-product-photo",
    category: "product",
    categoryLabel: "产品摄影",
    level: "入门",
    title: "春日茶饮产品摄影",
    description: "适合电商、菜单和生活方式内容，突出包装、液体和自然材质。",
    preview: "/inspiration/tea-product.png",
    tags: ["产品摄影", "茶饮", "自然质感"],
    size: "1536x1024",
    quality: "high",
    prompt:
      "拍摄一张原创春日茶饮产品照片：无品牌的哑光陶瓷茶罐与一杯浅绿色热茶放在深灰石材桌面上，杯中能看到舒展的茶叶，空气有轻微蒸汽。背景是虚化的绿色枝叶，清晨自然侧光，桌面保留水汽与细微纹理。画面简洁、安静、偏高端目录摄影，横版构图，左侧预留适量留白。不要任何文字、logo 或水印。",
  },
  {
    id: "old-town-night-watch-character-sheet",
    category: "character",
    categoryLabel: "角色设计",
    level: "进阶",
    title: "古城巡夜人设定稿",
    description: "用服装层次、随身工具和环境线索，建立可信的原创职业角色。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 4, y: 4, width: 410, height: 224 },
    tags: ["职业角色", "服装设计", "概念设定"],
    size: "1536x1024",
    quality: "high",
    prompt:
      "为一位原创古城巡夜人制作角色设定稿。画面包含成年角色的正面、侧面、背面全身视图；深墨绿色短披风、亚麻内衫、旧铜提灯、折叠地图筒、皮质工具腰带和防雨长靴。右侧展示提灯、钥匙串、雨披扣件和巡夜记录册的局部细节，背景为温和米灰色纸张与极淡的拱廊剪影。半写实概念艺术，材质清楚，配色克制，版式整洁。不要文字、不要 logo、不要水印、不要任何现有 IP 元素。",
  },
  {
    id: "deep-sea-researcher-character-sheet",
    category: "character",
    categoryLabel: "角色设计",
    level: "创意",
    title: "深海研究员装备图",
    description:
      "把人物、工具和任务场景放进同一套视觉规则，适合科幻项目的前期探索。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 422, y: 4, width: 408, height: 224 },
    tags: ["深海科幻", "装备拆解", "世界观"],
    size: "1536x1024",
    quality: "high",
    prompt:
      "设计一套原创深海研究员角色与装备图。角色为成年海洋地质学家，穿深蓝防水潜航服、带有透明颈部照明环和银灰色模块化氧气背包；呈现站立全身正视图与水下工作姿态。周围环绕采样管、岩芯盒、微型声呐、耐压手套和可折叠观察灯的精细拆解。色彩以深海蓝、海藻绿和安全橙为主，背景为洁净的浅灰蓝技术图纸质感。写实科幻概念设计，结构可信、细节丰富。不要可读文字、不要品牌、不要水印、不要现有 IP。",
  },
  {
    id: "garden-robot-companion-sheet",
    category: "character",
    categoryLabel: "角色设计",
    level: "入门",
    title: "机械花园伙伴拆解图",
    description:
      "适合轻量级创意角色：先明确轮廓、功能和配色，再补足可爱的细节。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 838, y: 4, width: 408, height: 224 },
    tags: ["机器人", "萌系角色", "拆解图"],
    size: "1536x1024",
    quality: "medium",
    prompt:
      "创作一个原创小型花园维护机器人设定图。机器人有圆润的乳白色金属身体、苔藓绿色顶盖、两只短机械臂和柔软橡胶履带，头部是一块发出暖黄光的简洁显示面板，不出现表情符号或文字。画面展示正面、侧面、背面和浇水模式的动作姿态，并补充喷壶模块、种子收纳仓、刷头和小叶片装饰的零件特写。背景简洁、明亮、带有淡淡园艺色彩，工业设计插画风格。不要品牌、不要水印、不要现有角色或 IP。",
  },
  {
    id: "smart-home-energy-dashboard",
    category: "ui",
    categoryLabel: "UI 界面",
    level: "进阶",
    title: "智能家居能耗控制台",
    description: "用层级卡片、房间状态和能耗趋势，构建有产品感的智能家居界面。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 4, y: 235, width: 410, height: 210 },
    tags: ["智能家居", "数据可视化", "应用界面"],
    size: "1536x1024",
    quality: "high",
    prompt:
      "设计一张原创智能家居能耗控制台 UI 概念图，展示在横向桌面显示器中。深蓝灰背景配以柔和薄荷绿和琥珀色状态点，界面包含房间卡片、能耗曲线、设备开关、温湿度图标、太阳能使用比例和本周趋势。所有文案位置均使用不可读的抽象短线与几何占位符，不要真实品牌、不要可读文字。现代数字产品设计，布局克制，玻璃质感卡片，柔和室内环境光，清晰但不过度复杂。",
  },
  {
    id: "travel-planning-app-mockup",
    category: "ui",
    categoryLabel: "UI 界面",
    level: "入门",
    title: "旅行行程编排应用",
    description:
      "将地图、时间线和收藏卡片合并，适合移动产品和服务流程的概念展示。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 422, y: 235, width: 408, height: 210 },
    tags: ["移动应用", "行程规划", "地图界面"],
    size: "1024x1536",
    quality: "high",
    prompt:
      "创作一张原创旅行行程规划移动应用 UI 概念图。手机竖屏界面采用温暖奶油白底色，搭配海蓝与珊瑚红点缀；上半部分是抽象海岸路线地图，下半部分是按时间排列的行程卡片、天气符号、照片缩略占位和收藏地点标签。不要真实地图数据、不要可读文字、不要品牌或 logo，所有信息均用不可读占位块表达。干净的产品设计展示，轻微投影，明亮自然光，具有高端旅行服务的感觉。",
  },
  {
    id: "reading-community-event-ui",
    category: "ui",
    categoryLabel: "UI 界面",
    level: "创意",
    title: "阅读社群活动页",
    description:
      "适合社群产品：用封面、成员状态和讨论节奏呈现温和而有秩序的参与感。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 838, y: 235, width: 408, height: 210 },
    tags: ["社群产品", "活动页面", "编辑设计"],
    size: "1536x1024",
    quality: "high",
    prompt:
      "设计一张原创阅读社群活动页面的桌面端 UI 概念图。整体采用纸张米白、墨绿和朱砂红点缀；页面包含一本抽象书籍封面占位、圆形成员头像占位、阅读进度环、讨论主题卡片和日历式活动栏。所有字形都必须是不可读的抽象线条或色块，不要真实书名、不要可读文字、不要品牌。编辑排版感与现代数字产品结合，留白充足，界面整洁、精致、可用性强。",
  },
  {
    id: "valley-music-festival-poster",
    category: "poster",
    categoryLabel: "海报视觉",
    level: "创意",
    title: "山谷音乐节主视觉",
    description:
      "用自然地形、舞台灯光和大面积色彩，做出既有气氛又方便后期排版的海报。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 4, y: 451, width: 410, height: 200 },
    tags: ["音乐节", "自然舞台", "主视觉"],
    size: "1024x1536",
    quality: "high",
    prompt:
      "创作一张竖版原创山谷音乐节主视觉海报。日落后的青绿色山谷之间搭起小型露天舞台，舞台灯光投向低雾，前景有几位背对镜头的观众剪影和起伏草坡，远处是橘粉色余晖。构图保留顶部约三分之一的纯净天空区域用于后期标题，画面具有颗粒感丝网印刷与电影光影的结合，鲜明但不杂乱。不要文字、不要 logo、不要任何已有音乐节标识或水印。",
  },
  {
    id: "polar-expedition-documentary-poster",
    category: "poster",
    categoryLabel: "海报视觉",
    level: "进阶",
    title: "极地科考纪录片海报",
    description: "通过极简人物比例和冷暖对比，表达宏大空间感与探索主题。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 422, y: 451, width: 408, height: 200 },
    tags: ["纪录片", "极地", "极简海报"],
    size: "1024x1536",
    quality: "high",
    prompt:
      "创作一张竖版原创极地科考纪录片海报：一艘小型科研雪地车停在巨大冰崖前，一名穿橙色保暖服的成年研究员站在车旁，比例很小。天空从深靛蓝渐变到冷白，冰层纹理清晰，远处有微弱极光和风雪颗粒。构图以空旷、安静和尺度反差为核心，下方保留干净留白用于后期信息。高级摄影与平面设计结合，冷暖色对比克制。不要文字、不要标志、不要水印、不要任何真实机构标识。",
  },
  {
    id: "coastal-rail-travel-poster",
    category: "poster",
    categoryLabel: "海报视觉",
    level: "入门",
    title: "海滨列车旅行海报",
    description:
      "用清晰的主体、色块和留白，快速生成适合旅行主题的复古宣传画面。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 838, y: 451, width: 408, height: 200 },
    tags: ["旅行海报", "复古插画", "海岸线"],
    size: "1024x1536",
    quality: "medium",
    prompt:
      "绘制一张竖版原创海滨列车旅行海报。一列奶油白与海军蓝相间的复古列车沿悬崖海岸缓慢行驶，车窗反射晴朗天空，海面呈现层次丰富的蓝绿色，前景有橘红色野花和低矮灌木。画面采用 20 世纪中叶旅行插画的平涂色块与柔和纸张质感，上方留出大块干净天空便于后期排版。不要任何文字、不要车站名、不要品牌、不要水印。",
  },
  {
    id: "rainy-street-monochrome-portrait",
    category: "portrait",
    categoryLabel: "人像摄影",
    level: "进阶",
    title: "雨后街头黑白人像",
    description: "通过环境反光、镜头距离和真实肤质，营造具有叙事感的街头肖像。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 4, y: 655, width: 410, height: 197 },
    tags: ["黑白摄影", "街头人像", "雨后"],
    size: "1024x1536",
    quality: "high",
    prompt:
      "拍摄一张原创雨后街头黑白人像。一位成年人物站在狭窄城市街道的屋檐下，深色短风衣微微潮湿，背景路面有雨水反光和虚化车灯。使用 50mm 镜头视角，近中景，柔和侧光，保留真实肤质、布料纹理与细腻灰阶，人物神态安静而专注。画面不要文字、不要品牌、不要水印、不要模仿任何真实人物或知名摄影作品。",
  },
  {
    id: "color-beauty-studio-portrait",
    category: "portrait",
    categoryLabel: "人像摄影",
    level: "创意",
    title: "彩色棚拍美妆肖像",
    description: "用简单色彩背景与精准柔光，把妆面、皮肤和饰品细节突出出来。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 422, y: 655, width: 408, height: 197 },
    tags: ["棚拍", "美妆人像", "彩色光"],
    size: "1024x1536",
    quality: "high",
    prompt:
      "拍摄一张原创彩色棚拍美妆肖像：一位成年女性面对镜头，背景为柔和的淡紫到浅杏色渐变，使用大面积柔光与一束微弱边缘光。妆面以透明光泽肌、珊瑚色眼影和自然唇色为主，佩戴无品牌的几何银色耳饰，肤质真实且有细微纹理。竖版半身构图，现代杂志摄影风格，画面干净、精致、色彩克制。不要文字、不要品牌、不要水印、不要使用真实人物肖像。",
  },
  {
    id: "track-athlete-motion-portrait",
    category: "portrait",
    categoryLabel: "人像摄影",
    level: "入门",
    title: "田径运动员动态肖像",
    description: "明确动作瞬间、服装材质和背景虚化，就能避免运动题材变得杂乱。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 838, y: 655, width: 408, height: 197 },
    tags: ["运动人像", "动态抓拍", "自然光"],
    size: "1024x1536",
    quality: "high",
    prompt:
      "拍摄一张原创田径运动员动态肖像。一位成年短跑运动员在清晨跑道上结束冲刺后回望镜头，穿无品牌的深蓝训练背心与浅灰短裤，皮肤有自然汗珠，背景跑道与看台被浅景深虚化。使用高速快门凝固衣角和呼吸感，侧逆光勾勒轮廓，色彩自然偏暖。竖版构图，真实体育编辑摄影风格。不要可读号码、不要文字、不要品牌、不要水印。",
  },
  {
    id: "sparkling-sports-drink-campaign",
    category: "marketing",
    categoryLabel: "品牌营销",
    level: "创意",
    title: "气泡运动饮料主视觉",
    description:
      "产品、飞溅液体和色彩背景统一后，画面会更接近可投放的广告主视觉。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 4, y: 858, width: 410, height: 185 },
    tags: ["饮料广告", "动感视觉", "新品主图"],
    size: "1536x1024",
    quality: "high",
    prompt:
      "创作一张原创气泡运动饮料营销主视觉。无品牌的半透明青柠色罐装饮料悬浮在明亮蓝绿色背景前，周围有冰块、气泡、水花和切开的青柠，罐身完全无文字。画面以高速摄影的清爽动感为核心，左侧留出干净留白用于后期广告信息，光线锐利、液体细节清楚、色彩充满能量。不要 logo、不要水印、不要复制任何现有饮料包装或广告。",
  },
  {
    id: "sculptural-candle-launch-visual",
    category: "marketing",
    categoryLabel: "品牌营销",
    level: "进阶",
    title: "雕塑香氛新品发布",
    description:
      "用器物材质、光影和负空间，打造安静但有高级感的生活方式营销画面。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 422, y: 858, width: 408, height: 185 },
    tags: ["香氛", "生活方式", "静物广告"],
    size: "1536x1024",
    quality: "high",
    prompt:
      "创作一张原创香氛蜡烛新品发布视觉。无品牌的磨砂玻璃烛杯放置在浅石灰色雕塑台座上，火焰温和，旁边有一枝银灰色干叶和柔软弧形布料。背景采用暖米白与浅烟灰的渐变，右侧保留充足留白，整体是高级艺术指导静物摄影，强调玻璃、蜡面与布料的细腻质感。瓶身和画面均不要文字、不要 logo、不要水印、不要现有品牌元素。",
  },
  {
    id: "sustainable-home-campaign",
    category: "marketing",
    categoryLabel: "品牌营销",
    level: "入门",
    title: "可持续家居系列广告",
    description:
      "用自然材质和留白构建可信的环保生活方式画面，适合首页 Banner 与社媒头图。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 838, y: 858, width: 408, height: 185 },
    tags: ["家居广告", "可持续设计", "生活方式"],
    size: "1536x1024",
    quality: "medium",
    prompt:
      "创作一张原创可持续家居产品广告画面。浅色木桌上摆放无品牌的再生玻璃花瓶、编织收纳篮、亚麻餐巾和一盏小型纸质台灯，窗外自然光投下树叶阴影。主色调为燕麦色、鼠尾草绿和柔和木色，画面左侧保留大块留白用于后期文案，强调自然材质与安静生活感。不要文字、不要 logo、不要水印、不要模仿任何现有家居品牌。",
  },
  {
    id: "wireless-earbuds-catalog-shot",
    category: "product",
    categoryLabel: "产品摄影",
    level: "进阶",
    title: "无线耳机静物目录",
    description: "明确产品角度、材质与背景反射，适合消费电子产品的干净目录图。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 4, y: 1049, width: 410, height: 199 },
    tags: ["消费电子", "目录摄影", "静物"],
    size: "1536x1024",
    quality: "high",
    prompt:
      "拍摄一张原创无线耳机产品目录照片。无品牌的象牙白充电盒半开，两个耳机整齐放置在旁边的浅灰亚克力台面上；背景为极淡蓝灰渐变，台面有细微倒影。使用柔和顶侧光突出磨砂塑料、金属充电触点和圆润轮廓，横版构图，画面精确、干净、现代。产品上不要可读标记，画面不要文字、不要 logo、不要水印。",
  },
  {
    id: "pour-over-coffee-tools-photo",
    category: "product",
    categoryLabel: "产品摄影",
    level: "入门",
    title: "手冲咖啡器具摄影",
    description:
      "把器具、咖啡液体与桌面材质分层描述，适合菜单和生活方式商品图。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 422, y: 1049, width: 408, height: 199 },
    tags: ["咖啡", "器具摄影", "生活方式"],
    size: "1536x1024",
    quality: "high",
    prompt:
      "拍摄一张原创手冲咖啡器具产品照片。透明玻璃滤杯、无品牌金属细口壶、浅木托盘和一只盛有深色咖啡的玻璃分享壶放在深胡桃木桌面上，咖啡蒸汽轻微上升，背景为虚化的暖灰墙面。上午窗边自然侧光，玻璃与木材纹理清晰，横版构图，安静克制、适合高端生活方式目录。不要文字、不要 logo、不要水印。",
  },
  {
    id: "ceramic-aroma-object-photo",
    category: "product",
    categoryLabel: "产品摄影",
    level: "创意",
    title: "陶瓷香薰器物摄影",
    description:
      "以器物的轮廓、表面釉色和投影为核心，快速得到有设计感的电商主图。",
    preview: "/inspiration/inspiration-atlas-v1.png",
    previewCrop: { x: 838, y: 1049, width: 408, height: 199 },
    tags: ["陶瓷", "香薰", "器物摄影"],
    size: "1536x1024",
    quality: "high",
    prompt:
      "拍摄一张原创陶瓷香薰器物摄影。一个无品牌的哑光白色陶瓷扩香器置于沙色石膏台座，器物顶部有柔和蒸汽，旁边放一块粗纹理石材和一小枝干燥植物。背景为浅暖灰色，午后斜向阳光形成清晰但柔和的投影，强调釉面微小颗粒和器物的几何轮廓。横版高端静物摄影，留白适中。不要文字、不要 logo、不要水印、不要已有品牌元素。",
  },
  {
    id: "violet-moon-mage-character-sheet",
    category: "character",
    categoryLabel: "角色设计",
    level: "创意",
    title: "紫月术士角色设定",
    description: "用轮廓、服装层次和少量道具，快速定义一个有记忆点的奇幻角色。",
    preview: "/inspiration/inspiration-atlas-v2.svg",
    previewCrop: { x: 0, y: 0, width: 418, height: 418 },
    tags: ["奇幻角色", "服装设定", "紫色氛围"],
    size: "1024x1536",
    quality: "high",
    prompt:
      "为一位原创紫月术士制作角色设定图。成年角色身穿深靛蓝长袍与淡紫色披肩，胸前有一枚无文字的月相吊坠，腰间带有几枚半透明魔法石。画面以半身正面为主，背景为深蓝到紫色的朦胧夜空，并在周围加入极细的月相线条与少量发光粒子。保持服装材质、手部姿态和面部表情清晰，不要文字、不要现有 IP、不要水印。",
  },
  {
    id: "ember-courier-character-portrait",
    category: "character",
    categoryLabel: "角色设计",
    level: "进阶",
    title: "余烬信使角色肖像",
    description: "用城市夜色、色温反差和轻量装备，让角色故事感更明确。",
    preview: "/inspiration/inspiration-atlas-v2.svg",
    previewCrop: { x: 418, y: 0, width: 418, height: 418 },
    tags: ["城市奇幻", "人物肖像", "夜色"],
    size: "1024x1536",
    quality: "high",
    prompt:
      "创作一张原创城市奇幻信使角色肖像。一位成年信使站在雨后石板街的暖色街灯下，穿深蓝短斗篷、皮革肩包和带金属扣件的轻型护具，手中拿一封发出微弱橙光的无字信件。背景是虚化的拱廊与潮湿反光，冷蓝环境光与暖橙灯光形成克制对比。竖版半身构图，真实布料与金属细节清晰。不要文字、不要品牌、不要水印、不要任何现有角色。",
  },
  {
    id: "garden-helper-robot-concept",
    category: "character",
    categoryLabel: "角色设计",
    level: "入门",
    title: "花园管家机器人概念",
    description: "适合练习非人角色：用任务、材质与环境互动建立可信的设计逻辑。",
    preview: "/inspiration/inspiration-atlas-v2.svg",
    previewCrop: { x: 836, y: 0, width: 418, height: 418 },
    tags: ["机器人", "环保设计", "可爱角色"],
    size: "1536x1024",
    quality: "medium",
    prompt:
      "设计一个原创花园管家机器人概念。圆角白色机身搭配鼠尾草绿的可更换工具模块，表情由两个柔和的发光圆点构成；机器人在温室中为幼苗浇水，旁边有育苗盘、湿润土壤和柔焦叶片。画面强调无害、实用、可持续的产品感，横版构图，清晨自然光，材质干净且有轻微使用痕迹。不要文字、不要 logo、不要模仿任何现有机器人品牌。",
  },
  {
    id: "museum-wayfinding-dashboard",
    category: "ui",
    categoryLabel: "UI 界面",
    level: "进阶",
    title: "美术馆导览工作台",
    description: "把地图、展厅状态和参观路径分层，适合复杂信息界面的结构练习。",
    preview: "/inspiration/inspiration-atlas-v2.svg",
    previewCrop: { x: 0, y: 418, width: 418, height: 418 },
    tags: ["数据界面", "导览系统", "深色 UI"],
    size: "1536x1024",
    quality: "high",
    prompt:
      "设计一张原创美术馆导览工作台的桌面端 UI 概念图。深蓝灰色界面包含抽象展厅平面图、路线节点、展览热度曲线、访客流量卡片和一组无可读文字的筛选控件；使用雾蓝与暖黄作信息强调，所有文字均以不可读短线和几何占位表达。界面显示在干净的横向屏幕中，信息清晰、层级克制、现代专业。不要真实机构名称、不要品牌、不要可读文字。",
  },
  {
    id: "wearable-health-orbit-ui",
    category: "ui",
    categoryLabel: "UI 界面",
    level: "创意",
    title: "可穿戴健康轨道界面",
    description: "用圆形数据、柔和渐变和少量高对比元素，做出有节奏的科技视觉。",
    preview: "/inspiration/inspiration-atlas-v2.svg",
    previewCrop: { x: 418, y: 418, width: 418, height: 418 },
    tags: ["可穿戴设备", "数据可视化", "紫粉渐变"],
    size: "1024x1024",
    quality: "high",
    prompt:
      "设计一张原创可穿戴健康设备的圆形数据界面概念图。画面中心是一个抽象心率或恢复度圆环，外侧分布睡眠、运动、呼吸和能量四个无文字模块；配色使用深紫底、淡紫环形数据与一处珊瑚粉重点，信息以不可读图形符号表达。整体是精致的数字产品视觉，正视角、极简但有层次，不要真实数字、不要品牌、不要可读文字。",
  },
  {
    id: "solitary-cinema-poster",
    category: "poster",
    categoryLabel: "海报视觉",
    level: "创意",
    title: "孤岛影院电影海报",
    description:
      "利用人物比例、山体结构与暖色光点，构建极简又有叙事张力的画面。",
    preview: "/inspiration/inspiration-atlas-v2.svg",
    previewCrop: { x: 836, y: 418, width: 418, height: 418 },
    tags: ["电影海报", "孤独感", "几何构图"],
    size: "1024x1536",
    quality: "high",
    prompt:
      "创作一张竖版原创独立电影海报。一位成年人物站在巨大的深色山体入口前，身后是暖红色的暮光与模糊云层，人物比例很小，衣服为低饱和暖色长外套。构图使用简洁三角形山体、明显留白和一束落在人物身上的柔光，具有诗意但不阴郁的电影感。顶部保留干净空间方便后期排版。不要文字、不要 logo、不要水印、不要模仿现有电影海报。",
  },
  {
    id: "paper-sculpture-brand-campaign",
    category: "marketing",
    categoryLabel: "品牌营销",
    level: "入门",
    title: "纸艺循环主题广告",
    description:
      "用纸张、弧线和单一颜色重点，快速做出适合公益或品牌理念传播的主视觉。",
    preview: "/inspiration/inspiration-atlas-v2.svg",
    previewCrop: { x: 0, y: 836, width: 418, height: 418 },
    tags: ["纸艺", "公益广告", "橙色视觉"],
    size: "1536x1024",
    quality: "medium",
    prompt:
      "创作一张原创纸艺循环主题品牌主视觉。柔和奶油色背景上，层叠纸张形成一个完整的橙红色圆环，圆环内部留出干净的浅色空间，周围散布少量剪纸叶片和细小纸屑。整体强调循环、轻盈和手工质感，横版构图，柔和棚拍光，边缘阴影细腻。不要文字、不要 logo、不要水印、不要任何现有品牌识别元素。",
  },
  {
    id: "botanical-tea-packaging-shot",
    category: "product",
    categoryLabel: "产品摄影",
    level: "进阶",
    title: "植物茶饮包装静物",
    description: "明确容器、标签留白和环境材质，可快速得到干净的包装提案图。",
    preview: "/inspiration/inspiration-atlas-v2.svg",
    previewCrop: { x: 418, y: 836, width: 418, height: 418 },
    tags: ["茶饮包装", "植物静物", "绿色产品"],
    size: "1536x1024",
    quality: "high",
    prompt:
      "拍摄一张原创植物茶饮包装静物。一个无品牌的米白色圆罐置于深青绿色背景前，标签只保留纯色块和抽象叶片图形；旁边有新鲜草本、半透明玻璃茶杯与柔和投影。容器表面为细腻哑光纸材，光线从侧上方打入，画面干净、自然、适合高端食品包装提案。不要可读文字、不要 logo、不要水印、不要复制已有品牌。",
  },
  {
    id: "architectural-table-lamp-editorial",
    category: "product",
    categoryLabel: "产品摄影",
    level: "创意",
    title: "建筑感台灯编辑摄影",
    description: "通过材质、投影和空间比例，让普通产品题材更有设计杂志的气质。",
    preview: "/inspiration/inspiration-atlas-v2.svg",
    previewCrop: { x: 836, y: 836, width: 418, height: 418 },
    tags: ["家居产品", "建筑摄影", "暖灰色"],
    size: "1536x1024",
    quality: "high",
    prompt:
      "拍摄一张原创建筑感台灯产品编辑摄影。一盏无品牌的奶油白桌灯位于深暖灰石膏背景前，细长金属灯杆、圆形灯罩和拱形底座形成清晰几何关系；桌面保留大片空白，灯光在墙上形成柔和弧形阴影。横版构图，材质细节精致克制，像独立设计杂志中的家居专题。不要文字、不要 logo、不要水印、不要已有品牌元素。",
  },
];
