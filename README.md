# SimMC 商城利润筛选器

这是一个 Chrome Manifest V3 扩展，用于在 `https://mall.vesego.xyz/` 商城页面中筛选利润、过滤异常价格和屏蔽指定港口，并支持从利润列表直接跳转到商城的物品详情。

当前版本：`v1.6.1`

## 快速开始

1. 打开 Chrome 的 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `mall-profit-extension` 目录。
5. 打开或刷新商城页面。

详细使用说明见 [`mall-profit-extension/README.md`](mall-profit-extension/README.md)。

## 目录

- `mall-profit-extension/`：扩展源码。
- `mall-profit-extension.zip`：可直接分发或放入 GitHub Release 的打包文件。
- `tools/e2e/`：可选的验证脚本（jsdom 无头测试 + 真实浏览器注入测试），不参与打包。

## 开发与验证

扩展本身没有运行时依赖，也不需要构建步骤。

```bash
# 核心算法测试
node mall-profit-extension/tests/profit-core.test.js

# 跳转与港口管理器的无头验证（需要 jsdom）
node tools/e2e/jsdom-harness.js
```

真实浏览器验证（需要 `agent-browser`）的做法见 [`tools/e2e/README.md`](tools/e2e/README.md)。
