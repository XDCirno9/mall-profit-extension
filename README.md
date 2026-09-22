# SimMC 商城利润筛选器

这是一个 Chrome Manifest V3 扩展，用于在 `https://mall.vesego.xyz/` 商城页面中筛选利润、过滤异常价格和屏蔽指定港口，并支持从利润列表直接跳转到商城的物品详情。

当前版本：`v1.6.0`

## 快速开始

1. 打开 Chrome 的 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `mall-profit-extension` 目录。
5. 刷新商城页面。

详细使用说明见 [`mall-profit-extension/README.md`](mall-profit-extension/README.md)。

## 交接给其他 AI/开发工具

换工具后，打开本目录，并让工具先读取：

- [`AGENTS.md`](AGENTS.md)：项目行为约束和开发命令。
- [`PROJECT_HANDOFF.md`](PROJECT_HANDOFF.md)：架构、需求、缓存和回归测试说明。

项目本身没有运行时依赖，扩展代码不需要安装任何 npm 包。只有可选的 jsdom 测试脚本需要 `jsdom`（见 `tools/e2e/README.md`）。

## 目录

- `mall-profit-extension/`：扩展源码。
- `mall-profit-extension.zip`：可直接分发或放入 GitHub Release 的打包文件。
- `tools/e2e/`：可选的验证脚本（jsdom 无头测试 + 真实浏览器注入测试），不参与打包。
- `AGENTS.md`：AI 开发代理指令。
- `PROJECT_HANDOFF.md`：完整项目交接说明。
