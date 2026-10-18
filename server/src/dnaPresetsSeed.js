// DNA 类目预设 seed（v2 草案定稿 2026-10-18）
// prompt 只存指引正文；Schema 由后端按 fields 自动拼成中文版追加，保证字段与 Schema 永不脱节
export const DNA_PRESET_SEED = [
  {
    id: 'suit', name: '男士西装', sort_order: 1,
    fields: [
      { key: 'silhouette', label: '版型', hint: '修身、常规、宽松' },
      { key: 'lapel', label: '驳头', hint: '戗驳头、平驳头、青果领' },
      { key: 'buttons', label: '扣型', hint: '单排一扣、单排两扣、单排三扣、双排四扣、双排六扣' },
      { key: 'vent', label: '开衩', hint: '单开衩、双开衩、不开衩' },
      { key: 'fabric', label: '面料外观', hint: '羊毛质感、羊绒质感、亚麻质感、棉质感、混纺质感、其他、未知' },
      { key: 'pattern', label: '面料图案', hint: '纯色、条纹、格纹、千鸟格、人字纹' },
      { key: 'primary_color', label: '主色', hint: '标准化颜色名称；无法判断填 null' },
      { key: 'secondary_color', label: '辅色', hint: '明显的第二主色；没有填 null' },
      { key: 'style', label: '风格', hint: '商务正装、商务休闲、意式、英式' },
      { key: 'details', label: '细节', hint: '标准化标签数组：贴兜、挖兜、票兜、里衬、手工明线、袖开衩等' },
      { key: 'scene', label: '场景', hint: '通勤、婚礼、日常' },
    ],
    prompt: `你是男士西装版师。仔细看图，提取西装款式 DNA，只返回 JSON，不要输出其他任何文字。
每个字段都是 {"value": 识别值, "confidence": 0~1 置信度}；看不清/不确定的字段 value 填 null 并给低置信度；面料只描述可观察的外观质感，不推断具体成分。
注意区分驳头类型（戗驳头/平驳头/青果领）与扣型（单排/双排、扣数）；开衩看后中是否开衩。`,
  },
  {
    id: 'dress', name: '女士连衣裙', sort_order: 2,
    fields: [
      { key: 'silhouette', label: '版型', hint: 'A字、修身、茧型、直筒、X型、蓬蓬' },
      { key: 'neckline', label: '领口', hint: '圆领、V领、方领、一字领、挂脖、高领、无领' },
      { key: 'sleeve_length', label: '袖长', hint: '无袖、短袖、七分袖、长袖' },
      { key: 'sleeve_type', label: '袖型', hint: '常规袖、泡泡袖、喇叭袖、飞袖、灯笼袖' },
      { key: 'skirt_length', label: '裙长', hint: '超短裙、短裙、膝上裙、中裙、长裙、拖地裙' },
      { key: 'skirt_shape', label: '裙摆结构', hint: '直裙、鱼尾、百褶、开衩、不对称' },
      { key: 'waistline', label: '腰线', hint: '高腰、自然腰、帝国式腰线、低腰、无腰线' },
      { key: 'fabric', label: '面料外观', hint: '真丝质感、雪纺质感、棉质感、亚麻质感、针织质感、缎面质感、其他、未知' },
      { key: 'primary_color', label: '主色', hint: '标准化颜色名称；无法判断填 null' },
      { key: 'secondary_color', label: '辅色', hint: '明显的第二主色；没有填 null' },
      { key: 'style', label: '风格', hint: '优雅、甜美、极简、复古、度假' },
      { key: 'details', label: '细节', hint: '标准化标签数组：刺绣、褶皱、镂空、系带、印花、拼接、荷叶边等' },
      { key: 'scene', label: '场景', hint: '日常、通勤、晚宴、度假、婚礼' },
    ],
    prompt: `你是女装设计师。仔细看图，提取连衣裙款式 DNA，只返回 JSON，不要输出其他任何文字。
每个字段都是 {"value": 识别值, "confidence": 0~1 置信度}；看不清/不确定的字段 value 填 null 并给低置信度；面料只描述可观察的外观质感，不推断具体成分。
注意：多数连衣裙无传统衣领，识别领口形状即可；袖长与袖型分开判断；裙长与裙摆结构分开判断；腰线重点看位置（帝国式腰线高于自然腰线）。`,
  },
  {
    id: 'tshirt', name: 'T恤', sort_order: 3,
    fields: [
      { key: 'silhouette', label: '版型', hint: '修身、常规、宽松、超宽松' },
      { key: 'collar', label: '领型', hint: '圆领、V领、亨利领、方领、Polo 领、立领；不常见填 null' },
      { key: 'sleeve', label: '袖长', hint: '短袖、长袖、五分袖' },
      { key: 'length', label: '衣长', hint: '常规、短款、长款' },
      { key: 'fabric', label: '面料外观', hint: '纯棉质感、混纺质感、速干质感、莫代尔质感、其他、未知' },
      { key: 'pattern', label: '图案', hint: '纯色、条纹、图形印花、字母印花、拼接色块' },
      { key: 'primary_color', label: '主色', hint: '标准化颜色名称；无法判断填 null' },
      { key: 'secondary_color', label: '辅色', hint: '明显的第二主色；没有填 null' },
      { key: 'style', label: '风格', hint: '基础、街头、复古、极简' },
      { key: 'details', label: '细节', hint: '标准化标签数组：刺绣、拼接、领口罗纹、下摆开衩、做旧等' },
      { key: 'scene', label: '场景', hint: '日常、运动、街头' },
    ],
    prompt: `你是服装款式分析师。仔细看图，提取T恤款式 DNA，只返回 JSON，不要输出其他任何文字。
每个字段都是 {"value": 识别值, "confidence": 0~1 置信度}；看不清/不确定的字段 value 填 null 并给低置信度；面料只描述可观察的外观质感，不推断具体成分。
图案字段只记录视觉图案（纯色/条纹/印花），刺绣、拼接等工艺结构放入细节。`,
  },
  {
    id: 'sweatshirt', name: '卫衣', sort_order: 4,
    fields: [
      { key: 'silhouette', label: '版型', hint: '修身、常规、宽松、超宽松' },
      { key: 'neckline', label: '领口', hint: '连帽、圆领、立领、半拉链立领' },
      { key: 'sleeve', label: '袖长', hint: '长袖、短袖' },
      { key: 'length', label: '衣长', hint: '常规、短款、长款' },
      { key: 'fabric', label: '面料外观', hint: '毛圈布、抓绒、罗纹针织、其他、未知' },
      { key: 'pattern', label: '图案', hint: '纯色、条纹、图形印花、字母印花' },
      { key: 'pocket', label: '口袋', hint: '袋鼠兜、无兜、侧兜' },
      { key: 'primary_color', label: '主色', hint: '标准化颜色名称；无法判断填 null' },
      { key: 'secondary_color', label: '辅色', hint: '明显的第二主色；没有填 null' },
      { key: 'style', label: '风格', hint: '街头、运动、复古、极简' },
      { key: 'details', label: '细节', hint: '标准化标签数组：抽绳、刺绣、拼接、罗纹收口、做旧等' },
      { key: 'scene', label: '场景', hint: '日常、运动、街头' },
    ],
    prompt: `你是服装款式分析师。仔细看图，提取卫衣款式 DNA，只返回 JSON，不要输出其他任何文字。
每个字段都是 {"value": 识别值, "confidence": 0~1 置信度}；看不清/不确定的字段 value 填 null 并给低置信度；面料只描述可观察的外观质感，不推断具体成分。
注意区分连帽/无帽结构；图案只记录视觉图案，刺绣、拼接等工艺放入细节。`,
  },
  {
    id: 'shirt', name: '衬衫', sort_order: 5,
    fields: [
      { key: 'silhouette', label: '版型', hint: '修身、常规、宽松、超宽松' },
      { key: 'collar', label: '领型', hint: '尖领、温莎领、立领、纽扣领、古巴领、翼领、其他' },
      { key: 'sleeve', label: '袖长', hint: '长袖、短袖' },
      { key: 'placket', label: '门襟', hint: '明门襟、暗门襟、法式门襟' },
      { key: 'fabric', label: '面料外观', hint: '牛津纺、府绸、牛仔布、灯芯绒、亚麻质感、真丝质感、针织、其他、未知' },
      { key: 'pattern', label: '图案', hint: '纯色、条纹、格纹、印花、提花、渐变' },
      { key: 'primary_color', label: '主色', hint: '可识别的颜色名称；无法判断填 null' },
      { key: 'secondary_color', label: '辅色', hint: '第二主要颜色；没有明显辅色填 null' },
      { key: 'style', label: '风格', hint: '商务、休闲、复古、极简、街头、正式' },
      { key: 'details', label: '细节', hint: '标准化标签数组：胸袋、双胸袋、后背褶、袖口纽扣、撞色领、刺绣、拼接等' },
      { key: 'scene', label: '场景', hint: '通勤、日常、正式' },
    ],
    prompt: `你是服装款式分析师。仔细看图，提取衬衫款式 DNA，只返回 JSON，不要输出其他任何文字。
每个字段都是 {"value": 识别值, "confidence": 0~1 置信度}；看不清/不确定的字段 value 填 null 并给低置信度；面料只描述可观察的外观质感，不推断具体成分。
重点看领型、门襟明暗与图案（条纹/格纹/纯色）。`,
  },
  {
    id: 'pants', name: '裤子', sort_order: 6,
    fields: [
      { key: 'silhouette', label: '裤型', hint: '直筒、修身、紧身、锥形、阔腿、微喇、喇叭、哈伦、工装' },
      { key: 'waist', label: '腰型', hint: '高腰、中腰、低腰' },
      { key: 'length', label: '裤长', hint: '超短裤、短裤、五分裤、七分裤、九分裤、全长' },
      { key: 'rise', label: '裆型', hint: '高裆、常规裆、低裆' },
      { key: 'fabric', label: '面料外观', hint: '牛仔布、西装料质感、棉布质感、针织、皮革、灯芯绒、其他、未知' },
      { key: 'pattern', label: '图案', hint: '纯色、条纹、格纹、迷彩、印花、渐变' },
      { key: 'primary_color', label: '主色', hint: '标准化颜色名称；无法判断填 null' },
      { key: 'secondary_color', label: '辅色', hint: '明显的第二主色；没有填 null' },
      { key: 'style', label: '风格', hint: '商务、休闲、街头、工装、运动、复古、户外' },
      { key: 'details', label: '细节', hint: '标准化标签数组：前褶、裤线、侧贴袋、斜插袋、口袋盖、破洞、水洗、抽绳、侧边条纹等' },
      { key: 'scene', label: '场景', hint: '通勤、日常、街头、运动' },
    ],
    prompt: `你是服装款式分析师。仔细看图，提取裤装款式 DNA，只返回 JSON，不要输出其他任何文字。
每个字段都是 {"value": 识别值, "confidence": 0~1 置信度}；看不清/不确定的字段 value 填 null 并给低置信度；面料只描述可观察的外观质感，不推断具体成分。
重点看裤型轮廓（直筒/锥形/阔腿）、腰线高低、裤长与裆型；牛仔裤注意水洗与破洞细节。`,
  },
  {
    id: 'skirt', name: '半裙', sort_order: 7,
    fields: [
      { key: 'silhouette', label: '裙型', hint: 'A字裙、直筒裙、包臀裙、百褶裙、伞裙、鱼尾裙、蛋糕裙、荷叶边裙' },
      { key: 'length', label: '裙长', hint: '超短裙、短裙、膝上裙、及膝裙、中长裙、长裙、拖地裙' },
      { key: 'waistline', label: '腰线', hint: '高腰、自然腰、低腰' },
      { key: 'waistband', label: '腰头设计', hint: '常规腰头、松紧腰、抽绳腰、无明显腰头' },
      { key: 'fabric', label: '面料外观', hint: '雪纺质感、缎面质感、棉布质感、牛仔布、皮革、针织、网纱、蕾丝、其他、未知' },
      { key: 'pattern', label: '图案', hint: '纯色、印花、格纹、条纹、波点、动物纹、渐变' },
      { key: 'primary_color', label: '主色', hint: '标准化颜色名称；无法判断填 null' },
      { key: 'secondary_color', label: '辅色', hint: '明显的第二主色；没有填 null' },
      { key: 'style', label: '风格', hint: '优雅、甜美、复古、街头、极简、学院、通勤、度假' },
      { key: 'details', label: '细节', hint: '标准化标签数组：开衩、褶裥、荷叶边、蕾丝拼接、口袋、腰带、纽扣、拉链、绑带、不对称下摆等' },
      { key: 'scene', label: '场景', hint: '日常、通勤、约会、度假' },
    ],
    prompt: `你是女装设计师。仔细看图，提取半裙款式 DNA，只返回 JSON，不要输出其他任何文字。
每个字段都是 {"value": 识别值, "confidence": 0~1 置信度}；看不清/不确定的字段 value 填 null 并给低置信度；面料只描述可观察的外观质感，不推断具体成分。
重点看裙型轮廓、裙长与腰头设计，开衩位置注意识别。`,
  },
  {
    id: 'knitwear', name: '毛衣针织', sort_order: 8,
    fields: [
      { key: 'silhouette', label: '版型', hint: '修身、常规、宽松、超宽松' },
      { key: 'collar', label: '领型', hint: '圆领、V领、高领、半高领、翻领、Polo领、船领、方领、连帽' },
      { key: 'sleeve', label: '袖长', hint: '无袖、短袖、七分袖、长袖' },
      { key: 'knit', label: '织法与纹理', hint: '平针、罗纹、绞花、麻花、镂空、网眼、蜂窝、华夫格、其他、未知' },
      { key: 'fabric', label: '面料外观', hint: '羊毛质感、羊绒质感、棉线质感、马海毛质感、毛圈、混合纱线外观、其他、未知' },
      { key: 'pattern', label: '图案', hint: '纯色、条纹、格纹、提花图案、费尔岛图案、菱格、几何图案、动物图案' },
      { key: 'primary_color', label: '主色', hint: '标准化颜色名称；无法判断填 null' },
      { key: 'secondary_color', label: '辅色', hint: '明显的第二主色；没有填 null' },
      { key: 'style', label: '风格', hint: '简约、复古、学院、温柔、街头、北欧、民族、休闲' },
      { key: 'details', label: '细节', hint: '标准化标签数组：领口罗纹、袖口罗纹、下摆罗纹、纽扣、拉链、口袋、流苏、毛边、拼色、刺绣、贴布等' },
      { key: 'scene', label: '场景', hint: '日常、通勤、居家' },
    ],
    prompt: `你是针织设计师。仔细看图，提取毛衣针织款式 DNA，只返回 JSON，不要输出其他任何文字。
每个字段都是 {"value": 识别值, "confidence": 0~1 置信度}；看不清/不确定的字段 value 填 null 并给低置信度；面料只描述可观察的外观质感，不推断具体成分。
重点看织法纹理（绞花/提花/平针）与领型。`,
  },
  {
    id: 'jacket', name: '外套夹克', sort_order: 9,
    fields: [
      { key: 'silhouette', label: '版型', hint: '修身、常规、宽松、超宽松' },
      { key: 'collar', label: '领型', hint: '立领、翻领、衬衫领、西装领、棒球领、连帽、无领' },
      { key: 'sleeve', label: '袖长', hint: '无袖、短袖、长袖' },
      { key: 'closure', label: '闭合方式', hint: '拉链、单排纽扣、双排纽扣、按扣、系带、敞开式、套头式' },
      { key: 'length', label: '衣长', hint: '超短款、短款、常规款、中长款、长款' },
      { key: 'fabric', label: '面料外观', hint: '牛仔布、皮革、麂皮、棉布质感、尼龙质感、羊毛呢质感、绗缝面料、针织、其他、未知' },
      { key: 'pattern', label: '图案', hint: '纯色、条纹、格纹、迷彩、印花、拼色、拼接、渐变' },
      { key: 'primary_color', label: '主色', hint: '标准化颜色名称；无法判断填 null' },
      { key: 'secondary_color', label: '辅色', hint: '明显的第二主色；没有填 null' },
      { key: 'style', label: '风格', hint: '休闲、街头、商务、工装、复古、运动、户外、极简' },
      { key: 'details', label: '细节', hint: '标准化标签数组：胸袋、侧袋、口袋盖、肩袢、袖口收紧、罗纹袖口、抽绳下摆、腰带、徽章、刺绣、做旧、绗缝、拼接等' },
      { key: 'scene', label: '场景', hint: '日常、通勤、街头、户外' },
    ],
    prompt: `你是服装款式分析师。仔细看图，提取外套夹克款式 DNA，只返回 JSON，不要输出其他任何文字。
每个字段都是 {"value": 识别值, "confidence": 0~1 置信度}；看不清/不确定的字段 value 填 null 并给低置信度；面料只描述可观察的外观质感，不推断具体成分。
重点看闭合方式（拉链/纽扣/敞开）、领型与衣长。`,
  },
];
