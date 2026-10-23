---
name: design-consistency
description: 检查已生成服装图之间的视觉一致性并报告差异。
license: MIT
metadata:
  version: "1"
---

调用 inspect_images 读取各产物实际像素，再比较服装色彩、领口、轮廓及模特身份，输出不确定项和差异。只给建议，不自动返工或无限循环；检查结果不是像素级保证。
