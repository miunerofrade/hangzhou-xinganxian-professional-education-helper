# 杭州学习新干线学习助手

一款面向**杭州专业技术人员学习新干线**用户的油猴脚本，帮助整理学习计划、管理课程播放，并查看平台已学学时。适用于在该平台参加继续教育、希望减少重复操作的学习者。

## 功能

- 按学习目标、课程类别和时长筛选课程，生成学习计划。
- 自动调度课程，支持暂停、继续、跳过和移除，也可手动同步平台已学记录。
- 核对课程进度与学时；播放异常时尝试恢复，并在日志中保留诊断信息。
- 提供自动静音、防息屏、开课时段和定时刷新设置。
- 支持常规界面、新拟态外观及自定义配色。

## 安装

1. 在浏览器中安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开仓库内的 [安装脚本](dist/hz-learning-helper.user.js)，点击 GitHub 文件页面的 **Raw**，按 Tampermonkey 提示安装。
3. 登录[杭州学习新干线](https://learning.hzrs.hangzhou.gov.cn/)，打开页面侧边的小球，设置学习目标并查找课程。

脚本为单文件，安装时无需单独下载源码模块。更新时重新安装新版本并刷新平台页面即可。

## 使用

在主页面设置目标学时和课程类别，点击「查找并安排课程」，确认学习计划后开始学习。设置中可以调整筛选条件、自动继续和刷新间隔；学习计划与日志可以折叠。播放页面可暂停、继续或移除当前课程。

学时概览同时展示平台确认值和已学列表合计，两者来自不同数据来源。部分课件或浏览器播放限制可能需要手动处理，具体状态可查看日志。

## 开发

需要 Node.js 20.19 或更高版本及 npm。

```bash
npm ci
npm test
npm run build
```

开发依赖通过 npm overrides 暂时将 `minimatch` 固定到修复版 11.0.1；ESLint 更新依赖范围后可再检查并移除覆盖。

源码位于 `src/`，构建后的安装文件位于 `dist/hz-learning-helper.user.js`。`npm run format:check` 检查代码格式；`node preview.mjs` 生成独立界面预览。

## 许可证与致谢

本项目采用 [MIT 许可证](LICENSE)。配色功能使用 Google 的 [Material Color Utilities](https://github.com/material-foundation/material-color-utilities)（Apache-2.0），部分图标使用 [Lucide](https://lucide.dev/)（ISC）；第三方代码保留其原有许可声明。
