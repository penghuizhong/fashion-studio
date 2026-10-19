// Versioned deterministic vocabulary; never rewrite stored DNA values.
export const RENDER_PROMPT_VERSION = 'explore-v2';
export const dnaRenderProfiles = {
  suit: {
    subject: "men's tailored suit jacket, clearly visible garment construction",
    terms: {
      silhouette: {
        修身: 'slim tailored fit',
        常规: 'regular tailored fit',
        宽松: 'relaxed tailored fit',
      },
      lapel: {
        戗驳头: 'peak lapels with upward-pointing tips',
        平驳头: 'notch lapels',
        青果领: 'shawl collar',
      },
      buttons: {
        单排一扣: 'single-breasted one-button front',
        单排两扣: 'single-breasted two-button front',
        单排三扣: 'single-breasted three-button front',
        双排四扣: 'double-breasted four-button front',
        双排六扣: 'double-breasted six-button front',
      },
      vent: {
        单开衩: 'single rear vent',
        双开衩: 'double rear vents',
        不开衩: 'ventless back',
        无开衩: 'ventless back',
      },
      fabric: {
        羊毛质感: 'visible wool-like suiting texture',
        羊绒质感: 'soft cashmere-like surface',
        亚麻质感: 'linen-like textured weave',
        棉质感: 'cotton-like surface',
        混纺质感: 'blended suiting texture',
        其他: 'distinctive suiting texture',
        未知: '',
      },
      pattern: {
        纯色: 'solid color fabric',
        条纹: 'striped fabric',
        格纹: 'checked fabric',
        千鸟格: 'houndstooth fabric',
        人字纹: 'herringbone weave',
      },
      style: {
        商务正装: 'formal business tailoring',
        商务休闲: 'business casual tailoring',
        意式: 'Italian tailoring',
        英式: 'British tailoring',
      },
      scene: {
        通勤: 'commuter outfit',
        婚礼: 'wedding outfit',
        日常: 'everyday outfit',
      },
      details: {
        贴兜: 'patch pockets',
        挖兜: 'welt pockets',
        票兜: 'ticket pocket',
        里衬: 'visible lining detail',
        手工明线: 'hand-finished pick stitching',
        袖开衩: 'sleeve vents',
      },
      primary_color: {
        黑: 'black',
        黑色: 'black',
        白: 'white',
        白色: 'white',
        藏蓝: 'navy blue',
        深蓝: 'dark blue',
        灰: 'gray',
        灰色: 'gray',
        米色: 'beige',
      },
      secondary_color: { 黑: 'black', 白: 'white', 灰: 'gray', 米色: 'beige' },
    },
  },
};
export const categorySubjects = {
  dress: "women's dress",
  tshirt: 'T-shirt',
  sweatshirt: 'sweatshirt',
  shirt: 'shirt',
  pants: 'trousers',
  skirt: 'skirt',
  jacket: 'jacket',
  coat: 'coat',
  knitwear: 'knitwear',
  knit: 'knitwear',
};
export function mappedDnaValue(presetId, key, value) {
  const v = String(value ?? '')
    .replace(/_/g, ' ')
    .trim();
  return dnaRenderProfiles[presetId]?.terms[key]?.[v] ?? v;
}
