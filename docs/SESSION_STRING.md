# 获取 TG_SESSION_STRING

`TG_SESSION_STRING` 是 GitHub Actions 登录你的 Telegram 用户号所需的会话字符串。

## 推荐方式

用 GitHub Codespaces、Replit、VPS 或电脑临时运行一次：

```bash
python -m pip install -U pip
python -m pip install -U "tg-signer[yaml]"
tg-signer login
```

按提示输入手机号、Telegram 验证码和二步验证密码。

如果命令输出 session string，把它复制到：

```text
GitHub 仓库 -> Settings -> Secrets and variables -> Actions -> New repository secret
```

名称填：

```text
TG_SESSION_STRING
```

值填 session string。

## 如果没有输出 session string

有些版本可能只生成本地 `.session` 文件。这时先不要把 `.session` 文件上传到公开仓库。

可选处理方式：

1. 换用支持导出 StringSession 的脚本。
2. 在私有安全环境中转换 session。
3. 先用电脑或 VPS 跑通，再迁移到 GitHub Actions。

## 安全要求

不要公开：

```text
完整手机号
Telegram 验证码
Telegram 二步验证密码
TG_SESSION_STRING
.session 文件
```
